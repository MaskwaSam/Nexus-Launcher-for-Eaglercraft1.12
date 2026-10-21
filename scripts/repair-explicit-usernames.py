#!/usr/bin/env python3
"""Apply/undo the reviewed explicit-username repair without altering saved profiles.

Only five existing compiled methods change in each edition. Two WASM
helpers reuse existing signatures; all other method bodies and assets are kept.
Debug addresses use TeaVM's module-byte-minus-one convention. The exact before
and after inputs are frozen; --undo returns the preceding reviewed checkpoint.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile

if not __debug__:
    raise RuntimeError('Byte repair requires enabled assertions; remove -O/PYTHONOPTIMIZE')
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('native_import_repair', Path(__file__).with_name('repair-native-import.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
BASE_JS = '21224555e5091b0a89e366b32c07a235bc62416dcb9ba0fe81a687fea70bc6b4'
BASE_EPW = '856faef3c5a11fbcf05cfb87fcaf5c92f0776b7200925dd062277621f543d11d'
BASE_WASM = '0a69472bdb4b2353a7069327d48a2a89751a033d2dad2b8b575dee5048c66b53'
BASE_DEBUG = '4fcb9bc840ae4bbaebed8658e8a505d73a7f5b82d1b820b7da960ebde5957678'
OUTPUT_JS = '30c71b7e008652bdda904edfe488d7e2bbbba8e3cc314c9102c1e5eb57c64830'
OUTPUT_EPW = '1a675662fe90ef02c7559d3b4d6506179afb3e4aacdcf0ebb16faa84bdfc8f30'
# Frozen lossless deltas, generated once from the exact reviewed baseline.
# They also permit independent undo without Git, archives or saved profile access.
FUNCTION_DELTAS = {'js': [('Etv', '66756e6374696f6e2045747628297b76617220622c632c642c652c662c672c682c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b683d24542e6c28293b673d24542e6c28293b663d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a48474a3d303b48474b3d282d31293b623d6e65772042623b633d4328363839293b24703d313b6361736520313a47717028622c63293b696628422829297b627265616b205f3b7d48474c3d623b48474d3d6e756c6c3b24703d323b6361736520323a527428293b696628422829297b627265616b205f3b7d48474e3d4847583b48474f3d303b4847503d282d31293b633d6e65772042623b623d4328363930293b24703d333b6361736520333a47717028632c62293b696628422829297b627265616b205f3b7d4847513d633b4847523d6e756c6c3b4847533d453228293b4847543d453228293b643d4728424a2c3136292e646174613b645b305d3d4328363931293b645b315d3d4328363931293b645b325d3d4328363932293b645b335d3d4328363932293b645b345d3d4328363933293b645b355d3d4328363934293b645b365d3d4328363935293b645b375d3d4328363936293b645b385d0a3d4328363937293b645b395d3d4328363938293b645b31305d3d4328363939293b645b31315d3d4328373030293b645b31325d3d4328373030293b645b31335d3d4328373031293b645b31345d3d4328373032293b645b31355d3d4328373033293b633d6e65772046683b24703d343b6361736520343a455a6f2863293b696628422829297b627265616b205f3b7d4847553d633b623d4328373034293b653d4728442c33293b663d652e646174613b633d4847553b673d642e6c656e6774683b665b305d3d645b4828632c67295d3b665b315d3d645b48284847552c67295d3b665b325d3d552848284847552c313030303029293b24703d353b6361736520353a247a3d474b6828622c65293b696628422829297b627265616b205f3b7d633d247a3b4847453d633b69662842672863293c3d3136297b633d4847453b24703d363b636f6e74696e7565205f3b7d623d4328373034293b653d4728442c33293b663d652e646174613b633d4847553b673d642e6c656e6774683b665b305d3d645b4828632c67295d3b665b315d3d645b48284847552c67295d3b665b325d3d552848284847552c313030303029293b636f6e74696e7565205f3b6361736520363a4633512863293b696628422829297b627265616b205f3b7d633d4847553b24703d373b6361736520373a4e6a28293b696628422829297b627265616b205f3b7d680a3d4828632c4847572e646174612e6c656e677468293b4847463d683b6966284847572e646174615b685d2e4e442e7a573d3d3d6e756c6c297b4847473d282d31293b4847483d303b4847493d282d31293b72657475726e3b7d633d4847553b636f6e74696e7565205f3b64656661756c743a465628293b7d7d447328292e7328622c632c642c652c662c672c682c2470293b7d0a766172204743383d4a28293b', '66756e6374696f6e2045747628297b76617220622c632c642c652c662c672c682c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b683d24542e6c28293b673d24542e6c28293b663d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a48474a3d303b48474b3d282d31293b623d6e65772042623b633d4328363839293b24703d313b6361736520313a47717028622c63293b696628422829297b627265616b205f3b7d48474c3d623b48474d3d6e756c6c3b24703d323b6361736520323a527428293b696628422829297b627265616b205f3b7d48474e3d4847583b48474f3d303b4847503d282d31293b633d6e65772042623b623d4328363930293b24703d333b6361736520333a47717028632c62293b696628422829297b627265616b205f3b7d4847513d633b4847523d6e756c6c3b4847533d453228293b4847543d453228293b633d6e65772046683b24703d343b6361736520343a455a6f2863293b696628422829297b627265616b205f3b7d4847553d633b4847453d2472745f737472282222293b633d4847453b24703d363b6361736520363a4633512863293b696628422829297b627265616b205f3b7d633d4847553b24703d373b6361736520373a4e6a28293b696628422829297b627265616b205f3b7d680a3d4828632c4847572e646174612e6c656e677468293b4847463d683b6966284847572e646174615b685d2e4e442e7a573d3d3d6e756c6c297b4847473d282d31293b4847483d303b4847493d282d31293b72657475726e3b7d633d4847553b636f6e74696e7565205f3b64656661756c743a465628293b7d7d447328292e7328622c632c642c652c662c672c682c2470293b7d0a766172204743383d4a28293b'), ('E_C', '66756e6374696f6e20455f432861297b76617220622c632c642c652c662c672c682c692c6a2c6b2c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b6b3d24542e6c28293b6a3d24542e6c28293b693d24542e6c28293b683d24542e6c28293b673d24542e6c28293b663d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b613d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a48494e3d313b623d432836383630293b633d4728442c30293b24703d313b6361736520313a247a3d47577628622c63293b696628422829297b627265616b205f3b7d623d247a3b612e63766c3d623b623d6e65772047653b643d303b653d612e4a3b663d2828612e722f327c30292d32307c30292b317c303b673d2828612e4c2f367c30292b32347c30292b317c303b683d3133383b693d32303b24703d323b6361736520323a46306e28622c642c652c662c672c682c69293b696628422829297b627265616b205f3b7d612e58243d623b643d313b24703d333b6361736520333a44387a28622c64293b696628422829297b627265616b205f3b7d623d612e58243b24703d343b6361736520343a247a3d45466428293b696628422829297b627265616b205f3b7d650a3d247a3b24703d353b6361736520353a44777728622c65293b696628422829297b627265616b205f3b7d4b7328612e58242c3136293b643d4847463b612e6b703d643d3d282d31293f4847473a642b4847532e687c303b623d612e62653b653d6e65772042333b643d303b693d28612e722f327c30292d3130307c303b663d28612e4c2f367c30292b3136387c303b6a3d432836383631293b633d4728442c30293b24703d363b6361736520363a247a3d475776286a2c63293b696628422829297b627265616b205f3b7d6a3d247a3b24703d373b6361736520373a42345328652c642c692c662c6a293b696628422829297b627265616b205f3b7d24703d383b6361736520383a5928622c65293b696628422829297b627265616b205f3b7d623d612e62653b653d6e65772042333b693d313b663d28612e722f327c30292d32317c303b673d28612e4c2f367c30292b3131307c303b683d37313b6b3d32303b6a3d432836383632293b633d4728442c30293b24703d393b6361736520393a247a3d475776286a2c63293b696628422829297b627265616b205f3b7d6a3d247a3b24703d31303b636173652031303a42726128652c692c662c672c682c6b2c6a293b696628422829297b627265616b205f3b7d24703d31313b636173652031313a5928622c65293b696628422829297b627265616b205f3b7d623d612e62653b650a3d6e65772042333b643d323b693d2828612e722f327c30292d32317c30292b37317c303b663d28612e4c2f367c30292b3131307c303b673d37323b683d32303b6a3d432836383633293b633d4728442c30293b24703d31323b636173652031323a247a3d475776286a2c63293b696628422829297b627265616b205f3b7d6a3d247a3b24703d31333b636173652031333a42726128652c642c692c662c672c682c6a293b696628422829297b627265616b205f3b7d24703d31343b636173652031343a5928622c65293b696628422829297b627265616b205f3b7d24703d31353b636173652031353a4572322861293b696628422829297b627265616b205f3b7d72657475726e3b64656661756c743a465628293b7d7d447328292e7328612c622c632c642c652c662c672c682c692c6a2c6b2c2470293b7d', '66756e6374696f6e20455f432861297b76617220622c632c642c652c662c672c682c692c6a2c6b2c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b6b3d24542e6c28293b6a3d24542e6c28293b693d24542e6c28293b683d24542e6c28293b673d24542e6c28293b663d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b613d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a48494e3d313b623d432836383630293b633d4728442c30293b24703d313b6361736520313a247a3d47577628622c63293b696628422829297b627265616b205f3b7d623d247a3b612e63766c3d623b623d6e65772047653b643d303b653d612e4a3b663d2828612e722f327c30292d32307c30292b317c303b673d2828612e4c2f367c30292b32347c30292b317c303b683d3133383b693d32303b24703d323b6361736520323a46306e28622c642c652c662c672c682c69293b696628422829297b627265616b205f3b7d612e58243d623b643d313b24703d333b6361736520333a44387a28622c64293b696628422829297b627265616b205f3b7d623d612e58243b24703d343b6361736520343a247a3d45466428293b696628422829297b627265616b205f3b7d650a3d247a3b24703d353b6361736520353a44777728622c65293b696628422829297b627265616b205f3b7d4b7328612e58242c3136293b643d4847463b612e6b703d643d3d282d31293f4847473a642b4847532e687c303b623d612e62653b653d6e65772042333b643d303b693d28612e722f327c30292d3130307c303b663d28612e4c2f367c30292b3136387c303b6a3d432836383631293b633d4728442c30293b24703d363b6361736520363a247a3d475776286a2c63293b696628422829297b627265616b205f3b7d6a3d247a3b24703d373b6361736520373a42345328652c642c692c662c6a293b696628422829297b627265616b205f3b7d24703d383b6361736520383a5928622c65293b696628422829297b627265616b205f3b7d6e6578757350726f66696c65446f6e6553746174652861293b623d612e62653b653d6e65772042333b693d313b663d28612e722f327c30292d32317c303b673d28612e4c2f367c30292b3131307c303b683d37313b6b3d32303b6a3d432836383632293b633d4728442c30293b24703d393b6361736520393a247a3d475776286a2c63293b696628422829297b627265616b205f3b7d6a3d247a3b24703d31303b636173652031303a42726128652c692c662c672c682c6b2c6a293b696628422829297b627265616b205f3b7d24703d31313b636173652031313a5928622c65293b696628422829297b627265616b205f3b7d623d612e62653b650a3d6e65772042333b643d323b693d2828612e722f327c30292d32317c30292b37317c303b663d28612e4c2f367c30292b3131307c303b673d37323b683d32303b6a3d432836383633293b633d4728442c30293b24703d31323b636173652031323a247a3d475776286a2c63293b696628422829297b627265616b205f3b7d6a3d247a3b24703d31333b636173652031333a42726128652c642c692c662c672c682c6a293b696628422829297b627265616b205f3b7d24703d31343b636173652031343a5928622c65293b696628422829297b627265616b205f3b7d24703d31353b636173652031353a4572322861293b696628422829297b627265616b205f3b7d72657475726e3b64656661756c743a465628293b7d7d447328292e7328612c622c632c642c652c662c672c682c692c6a2c6b2c2470293b7d'), ('FFd', '66756e6374696f6e2046466428612c622c63297b76617220642c652c662c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b663d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b613d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a643d612e58243b24703d313b6361736520313a47747128642c622c63293b696628422829297b627265616b205f3b7d643d612e58242e63413b69662842672864293e313629643d437528642c302c3136293b653d4328363833293b663d4328363834293b24703d323b6361736520323a247a3d465f5828642c652c66293b696628422829297b627265616b205f3b7d643d247a3b653d612e58243b24703d333b6361736520333a44777728652c64293b696628422829297b627265616b205f3b7d696628633d3d323030297b623d612e6b703b696628623e30297b623d622d317c303b612e6b703d623b612e6d313d622d327c303b7d7d696628633d3d323038297b623d612e6b703b696628623c28612e73472e646174612e6c656e6774682d317c3029297b623d622b317c303b612e6b703d623b612e6d313d622d327c303b7d7d72657475726e3b64656661756c743a465628293b7d7d447328292e7328612c0a622c632c642c652c662c2470293b7d', '66756e6374696f6e2046466428612c622c63297b76617220642c652c662c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b663d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b613d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a643d612e58243b24703d313b6361736520313a47747128642c622c63293b696628422829297b627265616b205f3b7d6e6578757350726f66696c65446f6e6553746174652861293b696628633d3d323030297b623d612e6b703b696628623e30297b623d622d317c303b612e6b703d623b612e6d313d622d327c303b7d7d696628633d3d323038297b623d612e6b703b696628623c28612e73472e646174612e6c656e6774682d317c3029297b623d622b317c303b612e6b703d623b612e6d313d622d327c303b7d7d72657475726e3b64656661756c743a465628293b7d7d447328292e7328612c0a622c632c642c652c662c2470293b7d'), ('E_$', '66756e6374696f6e20455f2428612c62297b76617220632c642c652c662c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b663d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b613d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a69662821612e7277297b633d622e62463b6966282163297b24703d313b636f6e74696e7565205f3b7d696628633d3d31297b623d4328383338293b643d432836383732293b24703d333b636f6e74696e7565205f3b7d696628633d3d32297b24703d373b636f6e74696e7565205f3b7d7d72657475726e3b6361736520313a445a572861293b696628422829297b627265616b205f3b7d24703d323b6361736520323a44553328293b696628422829297b627265616b205f3b7d69662821612e6a2e462e625261297b24703d353b636f6e74696e7565205f3b7d623d612e6a3b643d612e6361453b24703d343b636f6e74696e7565205f3b6361736520333a43493128622c64293b696628422829297b627265616b205f3b7d72657475726e3b6361736520343a47474d28622c64293b696628422829297b627265616b205f3b7d72657475726e3b6361736520353a247a3d45466428293b696628422829297b627265616b205f3b7d620a3d247a3b643d46692862293b623d432836383733293b24703d363b6361736520363a247a3d47466728642c62293b696628422829297b627265616b205f3b7d653d247a3b6966282165297b623d612e6a3b643d612e6361453b24703d343b636f6e74696e7565205f3b7d623d612e6a3b643d6e6577204257653b663d612e6361453b24703d31313b636f6e74696e7565205f3b6361736520373a46777028293b696628422829297b627265616b205f3b7d24703d383b6361736520383a445a572861293b696628422829297b627265616b205f3b7d24703d393b6361736520393a44553328293b696628422829297b627265616b205f3b7d24703d31303b636173652031303a4572322861293b696628422829297b627265616b205f3b7d612e6b703d303b72657475726e3b636173652031313a4247752864293b696628422829297b627265616b205f3b7d642e64546e3d613b642e6349543d663b24703d31323b636173652031323a47474d28622c64293b696628422829297b627265616b205f3b7d72657475726e3b64656661756c743a465628293b7d7d447328292e7328612c622c632c642c652c662c2470293b7d', '66756e6374696f6e20455f2428612c62297b76617220632c642c652c662c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b663d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b613d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a696628622e62463d3d3d302626216e657875734578706c696369744e616d6556616c696428612e58242e6341292972657475726e3b69662821612e7277297b633d622e62463b6966282163297b24703d313b636f6e74696e7565205f3b7d696628633d3d31297b623d4328383338293b643d432836383732293b24703d333b636f6e74696e7565205f3b7d696628633d3d32297b24703d373b636f6e74696e7565205f3b7d7d72657475726e3b6361736520313a445a572861293b696628422829297b627265616b205f3b7d24703d323b6361736520323a44553328293b696628422829297b627265616b205f3b7d69662821612e6a2e462e625261297b24703d353b636f6e74696e7565205f3b7d623d612e6a3b643d612e6361453b24703d343b636f6e74696e7565205f3b6361736520333a43493128622c64293b696628422829297b627265616b205f3b7d72657475726e3b6361736520343a47474d28622c64293b696628422829297b627265616b205f3b7d72657475726e3b6361736520353a247a3d45466428293b696628422829297b627265616b205f3b7d620a3d247a3b643d46692862293b623d432836383733293b24703d363b6361736520363a247a3d47466728642c62293b696628422829297b627265616b205f3b7d653d247a3b6966282165297b623d612e6a3b643d612e6361453b24703d343b636f6e74696e7565205f3b7d623d612e6a3b643d6e6577204257653b663d612e6361453b24703d31313b636f6e74696e7565205f3b6361736520373a46777028293b696628422829297b627265616b205f3b7d24703d383b6361736520383a445a572861293b696628422829297b627265616b205f3b7d24703d393b6361736520393a44553328293b696628422829297b627265616b205f3b7d24703d31303b636173652031303a4572322861293b696628422829297b627265616b205f3b7d612e6b703d303b72657475726e3b636173652031313a4247752864293b696628422829297b627265616b205f3b7d642e64546e3d613b642e6349543d663b24703d31323b636173652031323a47474d28622c64293b696628422829297b627265616b205f3b7d72657475726e3b64656661756c743a465628293b7d7d447328292e7328612c622c632c642c652c662c2470293b7d'), ('DZW', '66756e6374696f6e20445a572861297b76617220622c632c642c652c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b613d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a24703d313b6361736520313a497328293b696628422829297b627265616b205f3b7d623d4847532e683b633d612e6b703b696628633c62297b4847463d282d31293b4847473d633b7d656c73657b4847463d632d627c303b4847473d282d31293b7d643d453428612e58242e6341293b623d39353b69662842672864293c33297b653d6e6577204f3b512865293b24703d323b636f6e74696e7565205f3b7d69662842672864293e313629643d437528642c302c3136293b24703d343b636f6e74696e7565205f3b6361736520323a43774628652c64293b696628422829297b627265616b205f3b7d426528652c62293b24703d333b6361736520333a247a3d532865293b696628422829297b627265616b205f3b7d643d247a3b69662842672864293c33297b653d6e6577204f3b512865293b24703d323b636f6e74696e7565205f3b7d69662842672864293e313629643d437528642c302c3136293b24703d343b6361736520343a4633512864293b69660a28422829297b627265616b205f3b7d72657475726e3b64656661756c743a465628293b7d7d447328292e7328612c622c632c642c652c2470293b7d', '66756e6374696f6e20445a572861297b76617220622c632c642c652c24702c247a3b24703d303b696628465a2829297b7661722024543d447328293b24703d24542e6c28293b653d24542e6c28293b643d24542e6c28293b633d24542e6c28293b623d24542e6c28293b613d24542e6c28293b7d5f3a7768696c652874727565297b737769746368282470297b6361736520303a24703d313b6361736520313a497328293b696628422829297b627265616b205f3b7d623d4847532e683b633d612e6b703b696628633c62297b4847463d282d31293b4847473d633b7d656c73657b4847463d632d627c303b4847473d282d31293b7d643d612e58242e63413b696628216e657875734578706c696369744e616d6556616c69642864292972657475726e3b24703d343b6361736520343a4633512864293b69660a28422829297b627265616b205f3b7d72657475726e3b64656661756c743a465628293b7d7d447328292e7328612c622c632c642c652c2470293b7d')], 'wasm': [(698387, 'c0a105', 'c4a105'), (698390, 'f2dd02', 'f4dd02'), (784598, '', 'db26df2e'), (1163616, 'a6aff202', 'c5adf202'), (1163620, 'f2dd02', 'f4dd02'), (1520811, 'eb818000', '87818000'), (1520933, '10cc072103024003400263052003d60010e20108000b2103200310880241034e04400c020bfb01a50f210520052300fb05a50f0020052104200410ee012004200310ea011a200441df001085021a200410ed0121030c000b0b200310880241104a044020034100411010cf0321030b2003108243', '2103200310d4df02044020031082430b'), (3792536, 'c6868000', 'da848000'), (3792944, '02400340410310eb0121012001fb020902210223f23f21032000fb0f2104200241002000027f0263d8092003d60010e20108000b200410ef01210b0240200b4100480d00200b200b2000fb0f480d011a0b10e30108000bfb0b08fb1705fb0e08200241012000027f0263d80923f23fd60010e20108000b200410ef01210c0240200c4100480d00200c200c2000fb0f480d011a0b10e30108000bfb0b08fb1705fb0e08200241020263d80923f23fd60010e20108000b4190ce0010ef0110f501fb0e0823a5af012001109b03210520052499300263052005d60010e20108000b10880241104a04400c01050c020b0c000b0b239930108243', '23e354249930239930108243'), (3795804, '92828000', 'ad818000'), (3795841, '026305026399132000fb02b71612d60010e20108000bfb02991309d60010e20108000b2103200310880241104a044020034100411010cf0321030b0263052003d60010e20108000b23945f23902310ca0d2103026399132000fb02b71612d60010e20108000b200310c407', '200010d5df02'), (3797976, 'bc828000', 'dc828000'), (3797999, '', '2001fb02cf0d084504402000fb02b71612fb0299130910d4df024504400f0b0b'), (3799704, 'a3848000', 'a9848000'), (3800039, '', '200010d5df02'), (7231754, '', 'fb80800001037f2000d1044041000f0b200010880221012001410348200141104a72044041000f0b0340200220014e044041010f0b2000200210a3022103200341304e200341394c71200341c1004e200341da004c7172200341e1004e200341fa004c7172200341df00467245044041000f0b200241016a21020c000b000bab808000002000fb02b71607fb17bc0e4100108402fb17cf0d2000fb02b71612fb0299130910d4df02fb05cf0d090b')]}
DEBUG_DELTAS = [(403408, 'd3e13d', 'd2e13d'), (403411, '04ea8247', '04ee8247'), (497509, '0420', '040b'), (497513, '0413', '0400'), (497521, '0405', '0400'), (497531, '0408', '0400'), (497541, '0409', '0400'), (497550, '0407', '0400'), (497555, '98', '8a'), (497556, 'b6', 'aa'), (497557, '0405', '0400'), (950048, '04d301', '040c'), (950053, 'c5', 'aa'), (950054, 'd4', 'ca'), (950651, '0418', '0403'), (950662, '0402', '0400'), (950667, 'a8', '8a'), (950668, 'a2', '8a'), (950669, 'c2', 'aa'), (950869, '0413', '0433'), (951283, '0462', '0468')]
JS_HELPERS = b'''function nexusExplicitNameValid(a){if(a===null)return 0;var n=Bg(a);if(n<3||n>16)return 0;for(var i=0;i<n;i++){var c=Bn(a,i);if(!((c>=48&&c<=57)||(c>=65&&c<=90)||(c>=97&&c<=122)||c===95))return 0;}return 1;}
function nexusProfileDoneState(a){a.be.qP.data[0].bT=nexusExplicitNameValid(a.X$.cA);}
'''


def function_region(html, name):
    start = html.index(b'function ' + name + b'(')
    end = html.index(b'\nfunction ', start+1)
    return start, end


def js_edits(html):
    edits = []
    for name in (b'Etv', b'E_C', b'FFd', b'E_$', b'DZW'):
        a, z = function_region(html, name)
        old = html[a:z]
        new = old
        if name == b'Etv':
            start = new.index(b'd=G(BJ,16).data;')
            end = new.index(b'c=new Fh;', start)
            new = new[:start] + new[end:]
            start = new.index(b'HGU=c;')
            end = new.index(b'c=HGU;$p=7;', start)
            new = new[:start] + b'HGU=c;HGE=$rt_str("");c=HGE;$p=6;case 6:F3Q(c);if(B()){break _;}' + new[end:]
        elif name == b'E_C':
            before = b'case 8:Y(b,e);if(B()){break _;}'
            assert new.count(before) == 1
            new = new.replace(before, before + b'nexusProfileDoneState(a);')
        elif name == b'FFd':
            start = new.index(b'd=a.X$.cA;')
            end = new.index(b'if(c==200)', start)
            # Keep the user's raw field text. Never replace punctuation with
            # underscores, and never remove intentionally typed underscores.
            new = new[:start] + b'nexusProfileDoneState(a);' + new[end:]
        elif name == b'E_$':
            before = b'case 0:if(!a.rw)'
            assert new.count(before) == 1
            new = new.replace(before, b'case 0:if(b.bF===0&&!nexusExplicitNameValid(a.X$.cA))return;if(!a.rw)')
        else:
            start = new.index(b'd=E4(a.X$.cA);')
            end = new.index(b'F3Q(d);', start)
            new = new[:start] + b'd=a.X$.cA;if(!nexusExplicitNameValid(d))return;$p=4;case 4:' + new[end:]
        edits.append((a, z, new))
    edits.append((html.index(b'function Etv()'), html.index(b'function Etv()'), JS_HELPERS))
    return sorted(edits, key=lambda x: (x[0], x[1]))


def splice(data, edits):
    out = bytearray()
    p = 0
    for a, z, replacement in edits:
        assert p <= a <= z <= len(data)
        out += data[p:a] + replacement
        p = z
    return bytes(out + data[p:])


def patch_js(html):
    assert r.sha(html) == BASE_JS
    output = splice(html, js_edits(html))
    assert r.sha(output) == OUTPUT_JS
    return output


def undo_js(html):
    assert OUTPUT_JS != 'PENDING' and r.sha(html) == OUTPUT_JS
    # Reverse exact frozen function deltas; no name-prefix/profile migration.
    assert FUNCTION_DELTAS is not None
    for name, before, after in FUNCTION_DELTAS['js']:
        a, z = function_region(html, name.encode())
        assert html[a:z] == bytes.fromhex(after)
        html = html[:a] + bytes.fromhex(before) + html[z:]
    assert html.count(JS_HELPERS) == 1
    html = html.replace(JS_HELPERS, b'', 1)
    assert r.sha(html) == BASE_JS
    return html


def wasm_parts(wasm):
    sec = r.sections(wasm)
    p = sec[3][1]
    count, p = r.u(wasm, p)
    types = []
    for _ in range(count):
        t, p = r.u(wasm, p)
        types.append(t)
    assert p == sec[3][2]
    p = sec[10][1]
    count2, p = r.u(wasm, p)
    assert count == count2
    bodies = []
    for _ in range(count):
        a = p
        n, p = r.u(wasm, p)
        bodies.append((a, p, p+n))
        p += n
    assert p == sec[10][2]
    return sec, types, bodies


def call(index):
    return b'\x10' + r.leb(index)


def i32(value):
    # Positive signed LEB constants used below (ASCII/lengths only).
    b = r.leb(value)
    if b[-1] & 64:
        b = b[:-1] + bytes([b[-1] | 128, 0])
    return b'\x41' + b


def helper_bodies(valid_index):
    # predicate(String)->i32: null/length guards, then check each original char.
    # Uses existing String.length/charAt; no NBT, profile or random calls.
    valid = b'\x01\x03\x7f'  # locals1=length,2=index,3=char
    valid += b'\x20\x00\xd1\x04\x40\x41\x00\x0f\x0b'
    valid += b'\x20\x00' + call(264) + b'\x21\x01'
    valid += b'\x20\x01' + i32(3) + b'\x48\x20\x01' + i32(16) + b'\x4a\x72\x04\x40\x41\x00\x0f\x0b'
    valid += b'\x03\x40\x20\x02\x20\x01\x4e\x04\x40\x41\x01\x0f\x0b'
    valid += b'\x20\x00\x20\x02' + call(291) + b'\x21\x03'
    for lo, hi in ((48,57),(65,90),(97,122)):
        valid += b'\x20\x03' + i32(lo) + b'\x4e\x20\x03' + i32(hi) + b'\x4c\x71'
        if lo != 48:
            valid += b'\x72'
    valid += b'\x20\x03' + i32(95) + b'\x46\x72\x45\x04\x40\x41\x00\x0f\x0b'
    valid += b'\x20\x02\x41\x01\x6a\x21\x02\x0c\x00\x0b\x00\x0b'
    # refreshDone(Profile)->void. Original list[0] is the Done button.
    refresh = bytes.fromhex('002000fb02b71607fb17bc0e4100108402fb17cf0d2000fb02b71612fb02991309')
    refresh += call(valid_index) + bytes.fromhex('fb05cf0d090b')
    return valid, refresh


def wasm_method_edits(wasm, bodies, valid_index, refresh_index):
    edits = []
    text = bytes.fromhex('2000fb02b71612fb02991309')
    for f in (14752,2892,14797,14803,14807):
        prefix, start, end = bodies[f-226]
        body = wasm[start:end]
        local = []
        if f == 14752:
            # Retain RNG construction and the complete random-skin loop. Remove
            # only the random-name formatting/retry loop and its setName input.
            a = body.index(bytes.fromhex('02400340410310eb01'))
            z = body.index(bytes.fromhex('239930108243'), a) + len(bytes.fromhex('239930108243'))
            local.append((a,z,bytes.fromhex('23e354249930239930108243')))
        elif f == 2892:
            a = body.index(bytes.fromhex('10cc072103'))
            # The text-load/null-check block preceding this remains unchanged;
            # preserve selected skin writes and skip only invalid username writes.
            local.append((a,len(body)-1, b'\x21\x03\x20\x03' + call(valid_index) + b'\x04\x40\x20\x03' + call(8578) + b'\x0b'))
        elif f == 14797:
            a = body.index(bytes.fromhex('20012002109d091a')) + len(bytes.fromhex('20012002109d091a'))
            z = body.index(bytes.fromhex('200241c801460440'),a)
            local.append((a,z,b'\x20\x00' + call(refresh_index)))
        elif f == 14803:
            # Guard the Done action before saveProfile or navigation/warnings.
            p = 0
            n,p = r.u(body,p)
            for _ in range(n):
                _,p = r.u(body,p)
                p = r.val(body,p)
            guard = bytes.fromhex('2001fb02cf0d08450440') + text + call(valid_index) + bytes.fromhex('4504400f0b0b')
            local.append((p,p,guard))
        else:
            needle = bytes.fromhex('200410f6011a')
            a = body.index(needle) + len(needle)
            local.append((a,a,b'\x20\x00' + call(refresh_index)))
        for a,z,rep in local:
            edits.append((start+a,start+z,rep))
    return sorted(edits)


def apply_wasm(wasm):
    assert r.sha(wasm) == BASE_WASM
    sec, types, bodies = wasm_parts(wasm)
    assert len(types) == 44786 and types[264-226] == 4955 and types[2892-226] == 5983
    valid_index = 226 + len(types)
    refresh_index = valid_index + 1
    helpers = helper_bodies(valid_index)
    edits = wasm_method_edits(wasm,bodies,valid_index,refresh_index)
    # Fixed-width body lengths preserve every unrelated body's existing prefix.
    for a,start,end in bodies:
        delta = sum(len(rep)-(z-q) for q,z,rep in edits if start <= q <= z <= end)
        if delta:
            assert start-a == 4
            edits.append((a,start,r.leb(end-start+delta,4)))
    s3,p3,e3 = sec[3]
    old_count, after_count = r.u(wasm,p3)
    type_bytes = r.leb(4955) + r.leb(5983)
    function_section = r.leb(old_count+2,after_count-p3) + wasm[after_count:e3] + type_bytes
    edits += [(s3+1,p3,r.leb(len(function_section),p3-s3-1)),
              (p3,after_count,r.leb(old_count+2,after_count-p3)), (e3,e3,type_bytes)]
    code_s,code_p,code_e = sec[10]
    _, after_count = r.u(wasm,code_p)
    appended = b''.join(r.leb(len(x),4)+x for x in helpers)
    delta = sum(len(rep)-(z-a) for a,z,rep in edits if code_p <= a <= z <= code_e)
    edits += [(code_s+1,code_p,r.leb(code_e-code_p+delta+len(appended),code_p-code_s-1)),
              (code_p,after_count,r.leb(old_count+2,after_count-code_p)),
              (code_e,code_e,appended)]
    edits.sort(key=lambda x:(x[0],x[1]))
    output = splice(wasm,edits)
    # Exact body identity for every untouched original function.
    _, out_types, out_bodies = wasm_parts(output)
    assert out_types == types + [4955,5983]
    for i,(_,a,z) in enumerate(bodies):
        if i+226 not in (14752,2892,14797,14803,14807):
            _,q,e = out_bodies[i]
            assert wasm[a:z] == output[q:e]
    for i,h in enumerate(helpers):
        _,a,z = out_bodies[len(bodies)+i]
        assert output[a:z] == h
    assert r.sections(output).keys() == sec.keys()
    # Types/imports/globals/export/start/elements/data are byte-identical.
    out_sec = r.sections(output)
    for k,(a,_,z) in sec.items():
        if k not in (3,10):
            q,_,e = out_sec[k]
            assert wasm[a:z] == output[q:e]
    return output, edits


def map_address(address, edits):
    # TeaVM addresses are actual module bytes minus one.
    actual = address+1
    delta = 0
    for a,z,rep in edits:
        if actual < a:
            break
        if a <= actual < z:
            return a + delta + min(actual-a,len(rep))-1
        delta += len(rep)-(z-a)
    return actual+delta-1


def patch_debug(debug, wasm_edits):
    assert r.sha(debug) == BASE_DEBUG
    ds = r.tdbg_sections(debug)
    size_at,start,end = ds['teavm_line']
    line = debug[start:end]
    changes = []
    address = 0
    for a,z,op,v,old_address,_ in r.lines(line):
        mapped = map_address(old_address,wasm_edits)
        if op == 4:
            replacement = b'\x04' + r.leb(mapped-address)
            address = mapped
        elif op >= 10:
            delta = mapped-address
            assert delta >= 0
            if delta <= 31:
                replacement = bytes([10+((op-10)//32)*32+delta])
            else:
                replacement = b'\x04' + r.leb(delta) + bytes([10+((op-10)//32)*32])
            address = mapped
        else:
            replacement = line[a:z]
        if replacement != line[a:z]:
            changes.append((a,z,replacement))
    fixed_line = splice(line,changes)
    output = debug[:size_at] + r.leb(len(fixed_line)) + fixed_line + debug[end:]
    # Source state/method nesting is unchanged; every existing command's address
    # follows the targeted byte edit map. No unrelated debug section changes.
    old_semantic = [(op,v,map_address(addr,wasm_edits),depth) for _,_,op,v,addr,depth in r.lines(line) if op not in (4,) and op < 10]
    new_semantic = [(op,v,addr,depth) for _,_,op,v,addr,depth in r.lines(fixed_line) if op not in (4,) and op < 10]
    assert old_semantic == new_semantic
    for name,(_,a,z) in ds.items():
        if name != 'teavm_line':
            _,q,e = r.tdbg_sections(output)[name]
            assert output[q:e] == debug[a:z]
    return output, [(size_at,start,r.leb(len(fixed_line))), *[(start+a,start+z,rep) for a,z,rep in changes]]


def repack(payload,replacements):
    result = bytearray(payload)
    for at,content in sorted(replacements.items(),reverse=True):
        p,n = r.read32(result,at),r.read32(result,at+4)
        packed = r.compress(content)
        delta = len(packed)-n
        result[p:p+n] = packed
        for later in (228,244,260,292,324):
            if r.read32(result,later) >= p+n:
                struct.pack_into('<I',result,later,r.read32(result,later)+delta)
        struct.pack_into('<II',result,at+4,len(packed),len(content))
    struct.pack_into('<I',result,8,len(result))
    struct.pack_into('<I',result,12,r.zlib.crc32(result[16:]) & 0xffffffff)
    return bytes(result)


def component(payload,at):
    p,n = r.read32(payload,at),r.read32(payload,at+4)
    result = r.lzma.decompress(payload[p:p+n])
    assert len(result) == r.read32(payload,at+8)
    return result


def verify_payload(payload,expected):
    assert r.sha(payload) == expected
    assert payload[:8] == b'EAG$WASM' and r.read32(payload,8) == len(payload)
    assert r.read32(payload,12) == r.zlib.crc32(payload[16:]) & 0xffffffff


def apply_epw(payload):
    verify_payload(payload,BASE_EPW)
    wasm,debug = component(payload,228),component(payload,244)
    fixed_wasm,edits = apply_wasm(wasm)
    fixed_debug,debug_edits = patch_debug(debug,edits)
    output = repack(payload,{228:fixed_wasm,244:fixed_debug})
    assert r.sha(output) == OUTPUT_EPW
    for at in (196,212,260,292,324):
        a,n = r.read32(payload,at),r.read32(payload,at+4)
        q,e = r.read32(output,at),r.read32(output,at+4)
        assert n == e and payload[a:a+n] == output[q:q+e]
    validate_wasm(fixed_wasm)
    return output, edits, debug_edits


def reverse_deltas(data,deltas):
    edits = []
    shift = 0
    for a,before,after in deltas:
        before,after = bytes.fromhex(before),bytes.fromhex(after)
        a += shift
        assert data[a:a+len(after)] == after
        edits.append((a,a+len(after),before))
        shift += len(after)-len(before)
    return splice(data,edits)


def undo_epw(payload):
    verify_payload(payload,OUTPUT_EPW)
    assert FUNCTION_DELTAS is not None and DEBUG_DELTAS is not None
    wasm = reverse_deltas(component(payload,228),FUNCTION_DELTAS['wasm'])
    debug = reverse_deltas(component(payload,244),DEBUG_DELTAS)
    assert r.sha(wasm) == BASE_WASM and r.sha(debug) == BASE_DEBUG
    output = repack(payload,{228:wasm,244:debug})
    verify_payload(output,BASE_EPW)
    return output


def validate_wasm(wasm):
    with tempfile.NamedTemporaryFile(suffix='.wasm') as f:
        f.write(wasm)
        f.flush()
        subprocess.run([os.environ.get('NEXUS_NODE_EXECUTABLE','node'),'-e',
            'if(!WebAssembly.validate(require("fs").readFileSync(process.argv[1])))process.exit(1)',f.name],check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--undo',action='store_true')
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    js_path,wasm_path = args.root/'gamefile.html',args.root/'gamefilebetter.html'
    js,html = js_path.read_bytes(),wasm_path.read_bytes()
    match = re.search(r.PATTERN,html)
    assert match is not None and len(list(re.finditer(r.PATTERN,html))) == 1
    payload = base64.b64decode(match[1],validate=True)
    js_hash,payload_hash = r.sha(js),r.sha(payload)
    assert js_hash in (BASE_JS,OUTPUT_JS), 'Unreviewed JS bytes'
    assert payload_hash in (BASE_EPW,OUTPUT_EPW), 'Unreviewed EPW bytes'
    verify_payload(payload,payload_hash)
    expected_js,expected_epw = (BASE_JS,BASE_EPW) if args.undo else (OUTPUT_JS,OUTPUT_EPW)
    desired_js,desired_epw = js_hash == expected_js,payload_hash == expected_epw
    if desired_js and desired_epw:
        validate_wasm(component(payload,228))
        print(json.dumps({'status':'already_at_requested_state','js_sha256':expected_js,'epw_sha256':expected_epw}))
        return
    mixed = (js_hash == BASE_JS) != (payload_hash == BASE_EPW)
    if mixed and not args.apply:
        validate_wasm(component(payload,228))
        print(json.dumps({'status':'mixed_state_repair_required','js_sha256':js_hash,'epw_sha256':payload_hash}))
        raise SystemExit(1)
    # Independently recognize both frozen states before either atomic write.
    # An interrupted second write is safe to resume using --apply or --undo.
    if args.undo:
        new_js = js if desired_js else undo_js(js)
        new_payload = payload if desired_epw else undo_epw(payload)
    else:
        new_js = js if desired_js else patch_js(js)
        new_payload = payload if desired_epw else apply_epw(payload)[0]
    if args.apply:
        if not desired_js:
            r.atomic_write(js_path,new_js)
        if not desired_epw:
            r.atomic_write(wasm_path,html[:match.start(1)]+base64.b64encode(new_payload)+html[match.end(1):])
    print(json.dumps({'status':'written' if args.apply else 'verified_repair_required','js_sha256':r.sha(new_js),'epw_sha256':r.sha(new_payload),'epw_bytes':len(new_payload),'crc32':hex(r.read32(new_payload,12))},indent=2))



if __name__ == '__main__':
    main()
