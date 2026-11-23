import importlib.util
import json
import pathlib
import plistlib
import sqlite3
import tempfile
import time
import unittest
import zipfile
from contextlib import closing

root=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('reference',root/'pi-source/dtc-reference.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ReferenceTests(unittest.TestCase):
    def test_import_and_resolution(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=pathlib.Path(folder)
            archive=folder/'input.zip'
            variants=[
                dict(UDS=True,addressIndex='12 Index',descriptionFilename='A',group='F'),
                dict(UDS=True,addressIndex='34 Index',descriptionFilename='B',group='F'),
            ]
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('ecu-variants.plist',plistlib.dumps(variants))
                z.writestr('dat/A.plist',plistlib.dumps({'errors':{'0x000012':{'de':'Gemeinsam'},'0x001234':{'de':'Erster'}},
                    'infoErrors':{'0x007777':{'de':'Nur Info'}}},fmt=plistlib.FMT_BINARY))
                z.writestr('dat/B.plist',plistlib.dumps({'errors':{'0x000012':{'de':'Gemeinsam'},'0x001234':{'de':'Zweiter'},'0x1234':{'de':'Kurz'}}}))
                z.writestr('dat/bad.plist','corrupt')
            out=folder/'reference.sqlite'
            report=module.import_zip(archive,out)
            self.assertEqual(report['counts']['invalid_plist'],1)
            with closing(module.connect(out)) as db:
                self.assertEqual(module.lookup(db,'000012')['quality'],'global_consensus')
                self.assertEqual(module.lookup(db,'000012',None,{'family':'F'})['quality'],'family_consensus')
                self.assertEqual(module.lookup(db,'001234',0x12)['quality'],'address_consensus')
                self.assertEqual(module.lookup(db,'001234',None,{'variant':'A'})['quality'],'exact_variant')
                self.assertEqual(module.lookup(db,'001234')['quality'],'ambiguous')
                self.assertEqual(module.lookup(db,'007777')['quality'],'unknown_code')
            self.assertEqual(module.runtime('validate',out)['counts']['codes'],2)
            identity=dict(family='F',sgbd='A',variant=None)
            payload=folder/'motorscope.json'
            payload.write_text(json.dumps(dict(schema=1,ecu={'18':identity},entries=[dict(**identity,address=18,
                code='001234',title='Anderer Titel',description='Fiktive Beschreibung',verified=True)])))
            merged=folder/'merged.sqlite'
            module.merge_motorscope(out,payload,merged,'de')
            with closing(module.connect(merged)) as db:
                candidates=module.lookup(db,'001234',None,{'variant':'A'})
                self.assertEqual(candidates['quality'],'ambiguous')
                self.assertTrue(any(r['source']=='MotorScope / A' for r in candidates['candidates']))
            broken=folder/'wrong.zip';broken.write_bytes(b'not a zip')
            with self.assertRaises(zipfile.BadZipFile):module.import_zip(broken,folder/'wrong.sqlite')
            with self.assertRaises(sqlite3.DatabaseError):module.connect(broken)

    def test_scale(self):
        with tempfile.TemporaryDirectory() as folder:
            file=pathlib.Path(folder)/'scale.sqlite'
            with closing(sqlite3.connect(file)) as db:
                for statement in module.SCHEMA:db.execute(statement)
                db.executemany('INSERT INTO texts VALUES(?,?,?,?,?,?,?,?,?)',
                  ((f'V{i%700}',f'{i%57000:06X}',f'0x{i%57000:06X}','errors','de','Fiktiver Titel '+str(i%57000),None,'Test',0) for i in range(150000)))
                db.commit()
                start=time.perf_counter()
                for i in range(1000):self.assertEqual(module.lookup(db,f'{i:06X}')['quality'],'global_consensus')
                print(json.dumps({'syntheticRows':150000,'lookup1000Ms':round((time.perf_counter()-start)*1000,1),'bytes':file.stat().st_size}))

if __name__=='__main__':unittest.main()
