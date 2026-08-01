#!/usr/bin/env python3
"""Regenerates src/lib/settlement/__fixtures__/iban-stdnum.json.

    pip install python-stdnum
    python3 scripts/settlement/build-iban-fixtures.py

The point is INDEPENDENCE. `isValidIban` in counterparty-finance.ts is checked
against python-stdnum's IBAN registry and its own ISO 13616 MOD-97-10
implementation, rather than against expectations written by whoever wrote the
validator — self-written tests agree with self-written mistakes, and an IBAN
validator that only agrees with itself is how money reaches the wrong account.

Two findings came out of the first run, neither of which a hand-written test
would have produced: FK (Falkland Islands) was missing from our length table,
and five corrupted strings passed MOD-97 with check digits `00`, which is why
the validator now enforces the 02-98 range ISO 13616-1 specifies (and is
therefore deliberately stricter than stdnum).

Countries where stdnum applies an EXTRA national check over the BBAN (BE, ES,
ME, NO) are excluded from the generated cases and recorded in
`nationalCheckCountries`: a randomly generated BBAN cannot satisfy a national
checksum, so including them would test stdnum's national layer rather than the
ISO standard we implement.
"""

import json, random, re, string, importlib
from stdnum.iban import calc_check_digits, validate, _ibandb
from stdnum.exceptions import InvalidComponent

random.seed(20260801)

def bban_len(spec):
    return sum(int(c) for c, _, _ in re.findall(r'(\d+)(!?)([acn])', spec))

def bban_sample(spec, rnd):
    out = []
    for count, _, cls in re.findall(r'(\d+)(!?)([acn])', spec):
        pool = {'n': string.digits, 'a': string.ascii_uppercase,
                'c': string.digits + string.ascii_uppercase}[cls]
        out.append(''.join(rnd.choice(pool) for _ in range(int(count))))
    return ''.join(out)

lengths, specs, national = {}, {}, set()
for cc in (a + b for a in string.ascii_uppercase for b in string.ascii_uppercase):
    try:
        spec = _ibandb.info(cc + '00' + '0' * 30)[0][1].get('bban')
    except Exception:
        continue
    if not spec:
        continue
    lengths[cc], specs[cc] = bban_len(spec) + 4, spec
    try:
        importlib.import_module(f'stdnum.{cc.lower()}.iban')
        national.add(cc)      # stdnum applies an extra national BBAN check here
    except ImportError:
        pass

def independent_verdict(s):
    try:
        validate(s)
    except InvalidComponent:
        pass                   # national BBAN sub-format: deliberately out of our scope
    except Exception:
        return False
    return s[2:4].isdigit() and 2 <= int(s[2:4]) <= 98

cases, pool = [], string.digits + string.ascii_uppercase
# Skip countries with an extra national check: a random BBAN cannot satisfy it,
# so those cases would test stdnum's national layer, not ISO 13616.
for cc, spec in sorted(specs.items()):
    if cc in national:
        continue
    for _ in range(2):
        bban = bban_sample(spec, random)
        good = cc + calc_check_digits(cc + '00' + bban) + bban
        i = random.randrange(4, len(good))
        corrupted = good[:i] + random.choice([c for c in pool if c != good[i]]) + good[i+1:]
        for s in (good, corrupted, good + '1', good[:-1], cc + '00' + bban,
                  good.lower(), ' '.join(re.findall('.{1,4}', good))):
            cases.append({'iban': s, 'expect': independent_verdict(s.replace(' ', '').upper())})

json.dump({'source': 'python-stdnum IBAN registry + ISO 13616 MOD-97-10',
           'lengths': lengths, 'nationalCheckCountries': sorted(national), 'cases': cases},
          open('src/lib/settlement/__fixtures__/iban-stdnum.json', 'w'), indent=0)
valid = sum(1 for c in cases if c['expect'])
print(f"countries={len(lengths)} national={sorted(national)} cases={len(cases)} valid={valid} invalid={len(cases)-valid}")
