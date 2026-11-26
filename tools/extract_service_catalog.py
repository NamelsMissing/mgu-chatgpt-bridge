#!/usr/bin/env python3
"""Extract only maintenance enum projections from a local BMW SOME/IP catalogue."""
import json
import sys
from pathlib import Path

TYPES = {
    'ServiceStatusEnum': 'ServiceHistory',
    'StatusOperationType': 'ServiceHistory',
    'CBSColorEnum': 'KombiInterface_2',
    'IDCBS': 'ConditionBasedServicesLegacy',
    'IDScopeCBS': 'ConditionBasedServicesLegacy',
    'LegalInspectionAvailableEnum': 'BMW CBS',
    'ResetCBS': 'ConditionBasedServicesLegacy',
    'StatusCBSTeleservice': 'BMW CBS',
}
INFO = {
    'OELSERVICE': ('Motoröl', 'oil'),
    'BREMSBELAEGE_V': ('Bremsbeläge vorne', ''),
    'BREMSBELAEGE_H': ('Bremsbeläge hinten', ''),
    'BREMSFLUESSIGKEIT': ('Bremsflüssigkeit', 'brakeFluid'),
    'MIKROFILTER': ('Mikrofilter', 'microfilter'),
    'SICHTPRUEFUNGEN': ('Fahrzeug-Check', 'check'),
    'SICHTPRUEFUNG_ADAPTIV': ('Fahrzeug-Check (adaptiv)', 'check'),
    'KUEHLFLUESSIGKEIT': ('Kühlflüssigkeit', 'coolant'),
    'HU_HAUPTUNTERSUCHUNG': ('Hauptuntersuchung', 'inspection'),
    'AU_ABGASUNTERSUCHUNG': ('Abgasuntersuchung', ''),
    'DIESELPARTIKELFILTER': ('Dieselpartikelfilter', ''),
    'GETRIEBEOEL': ('Getriebeöl', ''),
    'GETRIEBEOEL_HAUPTGETRIEBE': ('Hauptgetriebeöl', ''),
    'H2_CHECK': ('Wasserstoffsystemprüfung', ''),
    'NOX_ADDITIV': ('AdBlue/NOx-Additiv', ''),
    'UEBERGABEDURCHSICHT': ('Übergabedurchsicht', ''),
    'EINFAHRKONTROLLE': ('Einfahrkontrolle', ''),
    'WASSERFILTER': ('Wasserfilter', ''),
    'ADDITIV_FUER_DIESELPARTIKELFILTER': ('DPF-Additiv', ''),
    'ZUENDKERZEN': ('Zündkerzen', ''),
    'ZUENDKERZEN_ADAPTIV': ('Zündkerzen (adaptiv)', ''),
    'SERVICE_PERFORMED': ('Durchgeführt', ''),
    'SERVICE_CARRIED_OUT_LATE': ('Verspätet durchgeführt', ''),
    'SERVICE_INCOMPLETE': ('Unvollständig', ''),
    'SIGNAL_UNBEFUELLT': ('Signal unbelegt', ''),
    'E_OK': ('Erfolgreich', ''),
    'E_FILE_DOES_NOT_EXIST': ('Datei nicht vorhanden', ''),
    'E_FILE_IS_EMPTY': ('Datei leer', ''),
    'E_NO_READ_PERMISSION': ('Leseberechtigung fehlt', ''),
    'HU': ('Hauptuntersuchung', ''),
    'AU': ('Abgasuntersuchung', ''),
    'SIGNAL_UNGUELTIG': ('Ungültiges Signal', ''),
    'WERT_UNGUELTIG': ('Ungültiger Wert', ''),
    'SERVICECALL_GETRIGGERT': ('Serviceanruf ausgelöst', ''),
    'SERVICECALL_IDLE': ('Serviceanruf inaktiv', ''),
    'KEINE_AKTION': ('Keine Aktion', ''),
    'UMFANG_RUECKSETZEN': ('Wartungsumfang zurücksetzen', ''),
    'RESERVE': ('Reserve', ''),
    'RESERVIERT': ('Reserviert', ''),
    'ROT': ('Rot', ''),
    'RED': ('Rot', ''),
    'YELLOW': ('Gelb', ''),
    'GREEN': ('Grün', ''),
    'ORANGE': ('Orange', ''),
    'DEFAULT': ('Standard', ''),
}

def project(catalog):
    rows = []
    for qualified, datatype in catalog['datatypes'].items():
        name = qualified.rsplit('.', 1)[-1]
        interface = TYPES.get(name)
        if 'SERVICEHISTORY_ADD_STAT_SH_ADD_DOP' in name:
            interface = 'DiagHMI'
        if not interface or datatype['type'] != 'enum':
            continue
        if not qualified.startswith(('de.bmw.infotainmenttypes.InfotainmentTypes.',
                                     'com.harman.infotainment.systemfunctions.ServiceHistoryTypes.',
                                     'de.bmw.infotainment.systemfunctions.diagnostics.job.HMI.DiagHMI.')):
            continue
        for original, code in sorted(datatype['items'].items(), key=lambda pair: pair[1]):
            de, work = INFO.get(original, ('', ''))
            reserved = original in {'RESERVE', 'RESERVIERT', 'SIGNAL_UNBEFUELLT', 'WERT_UNGUELTIG', 'SIGNAL_UNGUELTIG'}
            rows.append(dict(namespace='someip.' + qualified, code=code, original=original, de=de,
                             category={'IDScopeCBS': 'wartungsumfang', 'IDCBS': 'gesetzliche-untersuchung',
                                       'ResetCBS': 'steuerwert'}.get(name, 'status'),
                             work=work, interface=interface, source='someip-interfaces.json',
                             version=catalog['version'], verification='reserved' if reserved else 'verified'))
    return {'schema': 1, 'version': '1.0.0', 'rows': rows}

if __name__ == '__main__':
    print(json.dumps(project(json.loads(Path(sys.argv[1]).read_text())), ensure_ascii=False, indent=2))
