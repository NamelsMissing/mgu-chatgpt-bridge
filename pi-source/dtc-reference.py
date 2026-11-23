#!/usr/bin/env python3
"""Local BMW reference import and read-only, bounded lookup (Python standard library)."""
import argparse
import collections
import datetime
import hashlib
import json
import pathlib
import plistlib
import re
import sqlite3
import shutil
import sys
import tempfile
import zipfile

SCHEMA = (
    'CREATE TABLE imports(version TEXT, imported_at TEXT, source TEXT, stats TEXT)',
    'CREATE TABLE variants(ref TEXT, family TEXT, address INTEGER, uds INTEGER, original TEXT)',
    'CREATE TABLE texts(ref TEXT, code TEXT, original TEXT, kind TEXT, language TEXT, title TEXT, description TEXT, source TEXT, verified INTEGER)',
    'CREATE INDEX texts_code ON texts(code,kind,language)',
    'CREATE INDEX variants_ref ON variants(ref)',
    'CREATE INDEX variants_address ON variants(address,uds)',
    'CREATE INDEX variants_family ON variants(family)',
)
MAX_DB = 192 * 1024 * 1024

def import_zip(archive, destination):
    destination = pathlib.Path(destination)
    if destination.exists():
        raise ValueError('Zieldatei existiert bereits')
    stats = collections.Counter()
    problems = []
    def problem(name, reason):
        stats[reason] += 1
        if len(problems) < 100: problems.append([name,reason])
    with tempfile.TemporaryDirectory(dir=destination.parent) as folder, zipfile.ZipFile(archive) as z:
        files = [i for i in z.infolist() if not i.is_dir() and i.filename.lower().endswith('.plist')]
        if len(files) > 5000 or sum(i.file_size for i in files) > 512*1024*1024 or any(i.file_size > 16*1024*1024 for i in files):
            raise ValueError('Archiv überschreitet die Importgrenzen')
        table = [i for i in files if pathlib.PurePosixPath(i.filename).name.lower()=='ecu-variants.plist']
        if len(table)!=1: raise ValueError('Eindeutige ecu-variants.plist erforderlich')
        variants = plistlib.loads(z.read(table[0]))
        if not isinstance(variants,list): raise ValueError('Variantenliste ungültig')
        tmp=pathlib.Path(folder)/'reference.sqlite'
        db=sqlite3.connect(tmp)
        for statement in SCHEMA: db.execute(statement)
        stats['variant_entries']=len(variants)
        for row in variants:
            match=re.fullmatch(r'([0-9A-Fa-f]{2})\s+.+',str(row.get('addressIndex',''))) if isinstance(row,dict) else None
            if not match or not isinstance(row.get('descriptionFilename'),str) or not isinstance(row.get('group'),str) or type(row.get('UDS')) is not bool:
                problem('ecu-variants.plist','invalid_variant');continue
            db.execute('INSERT INTO variants VALUES(?,?,?,?,?)',(row['descriptionFilename'].upper(),row['group'].upper(),int(match[1],16),int(row['UDS']),row['addressIndex']))
        refs=set()
        member_names=set()
        for member in files:
            if member==table[0]: continue
            stats['reference_files']+=1
            if member.filename in member_names:
                problem(member.filename,'duplicate_member');continue
            member_names.add(member.filename)
            seen=set()
            ref=pathlib.PurePosixPath(member.filename).stem.upper()
            try:
                doc=plistlib.loads(z.read(member))
                if not isinstance(doc,dict): raise ValueError()
            except (ValueError,TypeError,OverflowError,zipfile.BadZipFile,plistlib.InvalidFileException):
                problem(member.filename,'invalid_plist');continue
            refs.add(ref)
            for kind in ('errors','infoErrors'):
                section=doc.get(kind,{})
                if not isinstance(section,dict):
                    problem(member.filename,'invalid_section');continue
                for original,entry in section.items():
                    if not re.fullmatch(r'0[xX][A-Fa-f0-9]{4,6}',original) or not isinstance(entry,dict):
                        stats['invalid_codes']+=1;continue
                    code=original[2:].upper()
                    if kind=='errors' and len(code)==6: stats['uds_width_occurrences']+=1
                    for language in ('de','en'):
                        title=entry.get(language)
                        if not isinstance(title,str) or not title.strip(): continue
                        key=(code,kind,language,title)
                        if key in seen:
                            stats['duplicates']+=1;continue
                        seen.add(key)
                        db.execute('INSERT INTO texts VALUES(?,?,?,?,?,?,NULL,?,0)',(ref,code,original,kind,language,title,'BMW PLIST / '+member.filename))
        for (ref,) in db.execute('SELECT DISTINCT ref FROM variants'):
            if ref not in refs: problem(ref,'missing_reference')
        stats.update(dict(db.execute("SELECT language,count(*) FROM texts GROUP BY language")))
        stats['codes'],stats['descriptions']=db.execute("SELECT count(DISTINCT code),count(description) FROM texts WHERE kind='errors' AND length(code)=6").fetchone()
        stats['variants']=db.execute('SELECT count(DISTINCT ref) FROM variants').fetchone()[0]
        stats['german_conflicts']=db.execute("SELECT count(*) FROM (SELECT code FROM texts WHERE kind='errors' AND length(code)=6 AND language='de' GROUP BY code HAVING count(DISTINCT title)>1)").fetchone()[0]
        details={'counts':dict(stats),'problems':problems}
        db.execute('INSERT INTO imports VALUES(?,?,?,?)',('1',datetime.datetime.now(datetime.timezone.utc).isoformat(),'BMW PLIST',json.dumps(details)))
        db.commit();db.close()
        if tmp.stat().st_size>MAX_DB: raise ValueError('Datenbank zu groß')
        tmp.chmod(0o600)
        # Exclusive destination makes accidental replacement impossible.
        destination.hardlink_to(tmp)
    return details

def connect(path):
    file=pathlib.Path(path).resolve()
    if not file.is_file() or file.stat().st_size>MAX_DB: raise ValueError('Datenbank fehlt oder ist zu groß')
    db=sqlite3.connect(file.as_uri()+'?mode=ro&immutable=1',uri=True)
    db.execute('PRAGMA trusted_schema=OFF')
    actual={r[0] for r in db.execute("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL")}
    if actual!=set(SCHEMA): raise ValueError('Unbekanntes Datenbankschema')
    return db

def lookup(db, code, address=None, identity=None):
    if not isinstance(code,str) or not re.fullmatch('[0-9A-F]{6}',code): return {'quality':'unknown_code'}
    levels=[]
    if identity:
        if identity.get('variant') or identity.get('sgbd'):
            names=list({str(identity[k]).upper() for k in ('variant','sgbd') if identity.get(k)})
            # Only a verified reference identifier can narrow to an exact variant.
            if len(names)==1:
                levels.append(('exact_variant','ref=?',names))
            else:
                return {'quality':'ambiguous','reason':'identity_conflict'}
        if identity.get('family'):
            levels.append(('family_consensus','ref IN (SELECT ref FROM variants WHERE family=? AND uds=1)',[str(identity['family']).upper()]))
    if type(address) is int:
        levels.append(('address_consensus','ref IN (SELECT ref FROM variants WHERE address=? AND uds=1)',[address]))
    levels.append(('global_consensus','1',[]))
    for quality,condition,args in levels:
        rows=db.execute("SELECT language,title,description,ref,source FROM texts WHERE code=? AND kind='errors' AND "+condition+
                        " ORDER BY language,ref,source LIMIT 5001",[code,*args]).fetchall()
        if not rows: continue
        if len(rows)>5000:return {'quality':'ambiguous','reason':'candidate_limit'}
        lang='de' if any(r[0]=='de' for r in rows) else 'en'
        candidates={}
        for language,title,description,ref,source in rows:
            if language!=lang:continue
            candidates.setdefault((' '.join(title.split()),' '.join((description or '').split())),
                                  dict(title=title[:500],description=description[:1200] if description else None,variant=ref[:80],source=source[:240],language=lang))
        if len(candidates)>1:return {'quality':'ambiguous','candidates':list(candidates.values())[:12],'candidateCount':len(candidates)}
        result=next(iter(candidates.values()))
        if quality!='exact_variant': result.pop('variant')
        return {**result,'quality':quality}
    return {'quality':'unknown_code'}

def merge_motorscope(base, imported, output, language):
    if language not in ('de','en'): raise ValueError('Sprache muss de oder en sein')
    output=pathlib.Path(output)
    if output.exists(): raise ValueError('Zieldatei existiert bereits')
    source=pathlib.Path(imported)
    if source.stat().st_size>4*1024*1024: raise ValueError('MotorScope-Zwischendatei zu groß')
    doc=json.loads(source.read_text(encoding='utf8'))
    if doc.get('schema')!=1 or not isinstance(doc.get('entries'),list): raise ValueError('Konvertierten MotorScope-Katalog verwenden')
    prior=runtime('validate',base)
    with tempfile.TemporaryDirectory(dir=output.parent) as folder:
        work=pathlib.Path(folder)/'merged.sqlite'
        shutil.copyfile(base,work)
        db=sqlite3.connect(work)
        seen=set()
        for row in doc['entries']:
            identity=doc.get('ecu',{}).get(str(row.get('address')), {})
            ref=(row.get('variant') or row.get('sgbd') or '').upper()
            code,title=row.get('code',''),row.get('title','')
            if row.get('verified') is not True or not re.fullmatch(r'[A-Z0-9_./-]{1,80}',ref) or not re.fullmatch('[0-9A-F]{6}',code) or not title.strip(): continue
            if any(identity.get(k)!=row.get(k) for k in ('sgbd','family','variant')): continue
            key=(ref,code,title)
            if key in seen: continue
            seen.add(key)
            db.execute('INSERT INTO texts VALUES(?,?,?,?,?,?,?,?,?)',
                (ref,code,code,'errors',language,title,row.get('description') or None,'MotorScope / '+row['sgbd'],1))
        if not seen: raise ValueError('Keine geprüften MotorScope-Zeilen')
        counts=prior['counts'];counts['motorscope_entries']=counts.get('motorscope_entries',0)+len(seen)
        counts.update(dict(db.execute("SELECT language,count(*) FROM texts GROUP BY language")))
        counts['codes'],counts['descriptions']=db.execute("SELECT count(DISTINCT code),count(description) FROM texts WHERE kind='errors' AND length(code)=6").fetchone()
        db.execute('UPDATE imports SET source=?, imported_at=?, stats=?',('BMW PLIST + MotorScope',
            datetime.datetime.now(datetime.timezone.utc).isoformat(),json.dumps({'counts':counts,'problems':prior.get('problems',[])})))
        db.commit();db.close()
        runtime('validate',work)
        work.chmod(0o600)
        output.hardlink_to(work)
    return counts

def runtime(mode,file):
    db=connect(file)
    version, imported, source, report=db.execute('SELECT version,imported_at,source,stats FROM imports').fetchone()
    meta={'version':version,'importedAt':imported,'source':source,'bytes':pathlib.Path(file).stat().st_size,**json.loads(report)}
    if not isinstance(meta.get('counts'),dict) or len(json.dumps(meta))>192*1024: raise ValueError('Ungültiger Importbericht')
    if mode=='validate':
        if db.execute('PRAGMA integrity_check').fetchone()!=('ok',): raise ValueError('SQLite-Integritätsprüfung fehlgeschlagen')
        if not db.execute('SELECT 1 FROM texts LIMIT 1').fetchone(): raise ValueError('Katalog ist leer')
        if db.execute("SELECT 1 FROM texts WHERE code IS NULL OR length(code) NOT BETWEEN 4 AND 6 OR code GLOB '*[^0-9A-F]*' OR title IS NULL OR length(title)>16384 OR length(description)>16384 OR language NOT IN ('de','en') OR language IS NULL OR kind NOT IN ('errors','infoErrors') OR kind IS NULL LIMIT 1").fetchone():
            raise ValueError('Ungültige Referenzeinträge')
        return meta
    requests=json.load(sys.stdin)
    if not isinstance(requests,list) or len(requests)>800:raise ValueError('Lookup-Limit')
    return {'meta':meta,'results':[lookup(db,r['code'],r.get('address'),r.get('identity')) for r in requests]}

if __name__=='__main__':
    try:
        if sys.argv[1] in ('lookup','validate'):
            print(json.dumps(runtime(sys.argv[1],sys.argv[2])))
        elif sys.argv[1]=='merge-motorscope':
            print(json.dumps(merge_motorscope(*sys.argv[2:])))
        else:
            parser=argparse.ArgumentParser(description=__doc__)
            parser.add_argument('zip');parser.add_argument('output')
            parser.add_argument('--report',type=pathlib.Path)
            args=parser.parse_args()
            result=import_zip(args.zip,args.output)
            if args.report: args.report.write_text(json.dumps(result,indent=2),encoding='utf8')
            print(json.dumps(result['counts'],indent=2))
    except Exception as e:
        print(str(e),file=sys.stderr);sys.exit(1)
