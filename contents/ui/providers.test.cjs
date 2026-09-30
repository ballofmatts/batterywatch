// Executes the onNewData handlers from the provider QML files with the QML
// scope stubbed, so the code under test is the code that ships.
// Keep beside the providers and run: node --test providers.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'GVariant.js'), 'utf8'), context);
const GVariant = { parseReply: context.parseReply };

// Braces inside a line comment must not shift the body, so count with the
// comment removed. No handler has a "//" inside a string literal.
const braceDelta = line => {
    let delta = 0;
    for (const ch of line.replace(/\/\/.*$/, '')) {
        if (ch === '{') delta++;
        else if (ch === '}') delta--;
    }
    return delta;
};

// Pull each `onNewData: (src, data) => { ... }` body out of a provider and
// compile it, so the assertions run the provider's own source.
function readHandlers(file) {
    const lines = fs.readFileSync(path.join(__dirname, 'providers', file), 'utf8').split('\n');
    const found = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/onNewData: \(src, data\) => \{/.test(lines[i])) continue;
        const body = [];
        let depth = 1;
        for (let j = i + 1; depth > 0 && j < lines.length; j++) {
            depth += braceDelta(lines[j]);
            if (depth === 0) { i = j; break; }
            body.push(lines[j].replace(/^ {12}/, ''));
        }
        const text = body.join('\n');
        found.push({
            body: text,
            readsReply: text.includes('parseReply'),
            run: new Function('src', 'data', 'root', 'i18n', 'Qt', 'GVariant',
                'const disconnectSource = () => {};\n' + text)
        });
    }
    return found;
}

const kde = readHandlers('KDEConnectProvider.qml');
const razer = readHandlers('OpenRazerProvider.qml');

// Key each handler by a string only it contains.
function byTag(list, tag) {
    const hits = list.filter(h => h.body.includes(tag));
    assert.equal(hits.length, 1, `expected exactly one handler containing ${JSON.stringify(tag)}`);
    return hits[0];
}

// The command line each DataSource is started with; the handlers read the
// device id out of it and ignore a src that does not carry one.
const SRC = {
    kdeList: '/usr/bin/gdbus call --session -d org.kde.kdeconnect -o /modules/kdeconnect -m org.kde.kdeconnect.daemon ListDevices',
    kdeId: id => `/usr/bin/gdbus call --session -d org.kde.kdeconnect -o /modules/kdeconnect -m org.kde.kdeconnect.device /devices/${id} org.kde.kdeconnect.device.GetAll`,
    razerList: '/usr/bin/openrazer-daemon --list-devices',
    razerId: (id, call) => `/usr/bin/openrazer-daemon --device 0x1533 0x1D5C 0x0265 /device/${id} ${call}`
};

const SEED = () => ({
    deviceData: { AAA: { name: 'Kept', battery: 42, charging: true }, BBB: { name: 'B', battery: 1, charging: false } },
    knownDevices: { AAA: true, BBB: true },
    devices: [], daemonUnavailable: false, kdeConnectEnabled: true, razerEnabled: true,
    fetchDeviceData() {}, refreshBattery() {}, fetchNameAndType() {}, fetchPowerInfo() {}
});

// Pass `root` to keep one provider state across replies, so a handler that
// damages it is visible to the next call.
function fire(handler, { reply, src, seed = SEED(), code = 0, stderr = '', root = null }) {
    root = root || Object.assign(SEED(), seed);
    const warnings = [];
    const i18n = (s, a) => s.replace('%1', a === undefined ? '' : a);
    let scheduled = 0;
    const Qt = { callLater() { scheduled++; }, refresh() { scheduled++; } };
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = m => warnings.push(m);
    console.log = () => {};
    let threw = null;
    try {
        handler.run(src, { ['exit code']: code, stdout: reply, stderr }, root, i18n, Qt, GVariant);
    } catch (error) {
        threw = error;
    }
    console.warn = realWarn;
    console.log = realLog;
    return { root, warnings, scheduled, threw };
}

// A reply the provider is meant to accept must not throw either.
function fireOk(handler, options) {
    const r = fire(handler, options);
    assert.equal(r.threw, null, `unexpected throw: ${r.threw && r.threw.message}`);
    return r;
}

// Replies that do not parse, and replies that parse into the wrong shape or
// the wrong type for the call that produced them.
const UNPARSEABLE = ['', null, 'nonsense', "(['aaa',", '()', '@as []', "'aaa'", '([', "({'a': <1>,}"];
const NOT_ARRAY = ["('aaa', 'bbb',)", "([['aaa', 'bbb']],)", '(1,)', "('aaa',)"];
const NOT_DICT = ['([],)', '(1,)', "('aaa',)", '(nan,)'];
const NOT_NUMBER = ["('88',)", '(nan,)', '(inf,)', '(true,)'];
const NOT_BOOL = ['(1,)', "('true',)"];
const NOT_STRING = ['(1,)', '(nan,)'];

const PARSING = [
    { name: 'KDE Connect device list', tag: 'expected an array of device ids',
      bad: [...UNPARSEABLE, ...NOT_ARRAY] },
    { name: 'KDE Connect properties', tag: "expected 'name' to be a string",
      bad: [...UNPARSEABLE, ...NOT_DICT, "({'name': <1>,},)", "({'type': <1>,},)"] },
    { name: 'KDE Connect battery', tag: "expected 'isCharging' to be a boolean",
      bad: [...UNPARSEABLE, ...NOT_DICT, "({'charge': <'x'>,},)", "({'isCharging': <1>,},)"] },
    { name: 'OpenRazer device list', tag: 'expected an array of device ids',
      bad: [...UNPARSEABLE, ...NOT_ARRAY] },
    { name: 'OpenRazer battery', tag: 'expected a finite number',
      bad: [...UNPARSEABLE, ...NOT_NUMBER] },
    { name: 'OpenRazer charging', tag: 'expected a boolean',
      bad: [...UNPARSEABLE, ...NOT_BOOL] },
    { name: 'OpenRazer details', tag: 'expected a string',
      bad: [...UNPARSEABLE, ...NOT_STRING] }
];

// What each handler must leave alone when it refuses a reply.
const UNCHANGED = {
    'KDE Connect device list': root => {
        assert.deepEqual(Object.keys(root.knownDevices), ['AAA', 'BBB']);
        assert.deepEqual(Object.keys(root.deviceData), ['AAA', 'BBB']);
    },
    'KDE Connect properties': root => {
        assert.equal(root.deviceData.AAA.name, 'Kept');
        assert.equal(root.deviceData.AAA.type, 'phone');
    },
    'KDE Connect battery': root => {
        assert.equal(root.deviceData.AAA.charge, 42);
        assert.equal(root.deviceData.AAA.charging, false);
    },
    'OpenRazer device list': root => {
        assert.deepEqual(Object.keys(root.knownDevices), ['AAA', 'BBB']);
        assert.deepEqual(Object.keys(root.deviceData), ['AAA', 'BBB']);
    },
    'OpenRazer battery': root => assert.equal(root.deviceData.AAA.battery, 42),
    'OpenRazer charging': root => assert.equal(root.deviceData.AAA.charging, true),
    'OpenRazer details': root => assert.equal(root.deviceData.AAA.name, 'Kept')
};

const SRC_FOR = {
    'KDE Connect device list': () => SRC.kdeList,
    'KDE Connect properties': () => SRC.kdeId('AAA'),
    'KDE Connect battery': () => SRC.kdeId('AAA'),
    'OpenRazer device list': () => SRC.razerList,
    'OpenRazer battery': () => SRC.razerId('AAA', 'misc.getBattery'),
    'OpenRazer charging': () => SRC.razerId('AAA', 'misc.getCharging'),
    'OpenRazer details': () => SRC.razerId('AAA', 'misc.getDeviceName')
};

const handlerFor = name => {
    const spec = PARSING.find(p => p.name === name);
    const list = name.startsWith('KDE') ? kde : razer;
    return byTag(list, spec.tag);
};

const SEED_FOR = {
    'KDE Connect properties': { deviceData: { AAA: { name: 'Kept', type: 'phone' } } },
    'KDE Connect battery': { deviceData: { AAA: { charge: 42, charging: false } } },
    'OpenRazer battery': { deviceData: { AAA: { battery: 42 } } },
    'OpenRazer charging': { deviceData: { AAA: { charging: true } } },
    'OpenRazer details': { deviceData: { AAA: { name: 'Kept' } } }
};

test('every provider handler is found and compiled', () => {
    assert.equal(kde.length, 4, 'KDE Connect DataSource count changed');
    assert.equal(razer.length, 4, 'OpenRazer DataSource count changed');
    const parsing = [...kde, ...razer].filter(h => h.readsReply);
    assert.equal(parsing.length, 7, 'a handler stopped reading a reply through GVariant');
    for (const spec of PARSING) byTag(spec.name.startsWith('KDE') ? kde : razer, spec.tag);
});

test('a refused reply never throws, never changes device data, never refreshes', () => {
    for (const spec of PARSING) {
        const handler = handlerFor(spec.name);
        for (const reply of spec.bad) {
            const label = `${spec.name} ${JSON.stringify(reply)}`;
            const r = fire(handler, { reply, src: SRC_FOR[spec.name](), seed: SEED_FOR[spec.name] });
            assert.equal(r.threw, null, `${label} threw`);
            assert.equal(r.warnings.length, 1, `${label} was not reported exactly once`);
            assert.equal(r.scheduled, 0, `${label} scheduled a refresh`);
            UNCHANGED[spec.name](r.root);
        }
    }
});

test('a valid reply is applied', () => {
    let r = fireOk(handlerFor('KDE Connect device list'), { reply: "(['id1', 'id2'],)", src: SRC.kdeList, seed: { deviceData: {}, knownDevices: {} } });
    assert.deepEqual(Object.keys(r.root.knownDevices), ['id1', 'id2']);

    r = fireOk(handlerFor('KDE Connect properties'), {
        reply: `({'name': <"Bob's Phone">, 'type': <'phone'>,},)`, src: SRC.kdeId('id1'),
        seed: { deviceData: { id1: { name: '', type: '' } } }
    });
    assert.equal(r.root.deviceData.id1.name, "Bob's Phone");
    assert.equal(r.root.deviceData.id1.type, 'phone');

    r = fireOk(handlerFor('KDE Connect battery'), {
        reply: "({'charge': <75>, 'isCharging': <false>},)", src: SRC.kdeId('id1'),
        seed: { deviceData: { id1: { charge: -1, charging: true } } }
    });
    assert.equal(r.root.deviceData.id1.charge, 75);
    assert.equal(r.root.deviceData.id1.charging, false);

    r = fireOk(handlerFor('OpenRazer device list'), { reply: "(['AAA', 'BBB'],)", src: SRC.razerList, seed: { deviceData: {}, knownDevices: {} } });
    assert.deepEqual(Object.keys(r.root.knownDevices), ['AAA', 'BBB']);

    r = fireOk(handlerFor('OpenRazer battery'), { reply: '(85.0,)', src: SRC.razerId('AAA', 'misc.getBattery'), seed: { deviceData: { AAA: { battery: 0 } } } });
    assert.equal(r.root.deviceData.AAA.battery, 85);

    r = fireOk(handlerFor('OpenRazer charging'), { reply: '(true,)', src: SRC.razerId('AAA', 'misc.getCharging'), seed: { deviceData: { AAA: { charging: false } } } });
    assert.equal(r.root.deviceData.AAA.charging, true);

    r = fireOk(handlerFor('OpenRazer details'), { reply: `(<"Razer Viper's Pro">,)`, src: SRC.razerId('AAA', 'misc.getDeviceName'), seed: { deviceData: { AAA: { name: '' } } } });
    assert.equal(r.root.deviceData.AAA.name, "Razer Viper's Pro");
});

test('a missing property keeps its previous value', () => {
    let r = fireOk(handlerFor('KDE Connect properties'), {
        reply: "({'name': <'Renamed'>,},)", src: SRC.kdeId('AAA'),
        seed: { deviceData: { AAA: { name: 'Kept', type: 'phone' } } }
    });
    assert.equal(r.root.deviceData.AAA.name, 'Renamed');
    assert.equal(r.root.deviceData.AAA.type, 'phone');

    r = fireOk(handlerFor('KDE Connect battery'), {
        reply: "({'isCharging': <true>,},)", src: SRC.kdeId('AAA'),
        seed: { deviceData: { AAA: { charge: 42, charging: false } } }
    });
    assert.equal(r.root.deviceData.AAA.charge, 42);
    assert.equal(r.root.deviceData.AAA.charging, true);
});

test('an empty device list disconnects the devices', () => {
    const r = fireOk(handlerFor('OpenRazer device list'), { reply: '(@as [],)', src: SRC.razerList });
    assert.deepEqual(Object.keys(r.root.knownDevices), []);
    assert.deepEqual(Object.keys(r.root.deviceData), []);
    assert.equal(r.scheduled, 1);
});

test('a refused device list leaves polling enabled and does not stop the next poll', () => {
    for (const [name, enabled] of [
        ['KDE Connect device list', 'kdeConnectEnabled'],
        ['OpenRazer device list', 'razerEnabled']
    ]) {
        const handler = handlerFor(name);
        const src = SRC_FOR[name]();
        const root = Object.assign(SEED(), { knownDevices: { AAA: true, BBB: true } });

        // One state, carried across every reply, so a handler that leaves
        // polling disabled or the daemon flagged is caught here.
        for (const bad of ['', "([['AAA', 'BBB']],)", 'nonsense']) {
            const r = fire(handler, { reply: bad, src, root });
            assert.equal(r.threw, null, `${name} threw on ${JSON.stringify(bad)}`);
            assert.equal(r.root[enabled], true, `${name} disabled polling on ${JSON.stringify(bad)}`);
            assert.equal(r.root.daemonUnavailable, false, `${name} flagged the daemon on ${JSON.stringify(bad)}`);
            assert.deepEqual(Object.keys(r.root.knownDevices), ['AAA', 'BBB'], `${name} pruned devices on ${JSON.stringify(bad)}`);
        }

        const r = fire(handler, { reply: "(['AAA'],)", src, root });
        assert.equal(r.threw, null, `${name} threw on the valid reply`);
        assert.equal(r.root[enabled], true, `${name} disabled polling on the valid reply`);
        assert.deepEqual(Object.keys(r.root.knownDevices), ['AAA'], `${name} did not apply the valid reply`);
        assert.deepEqual(Object.keys(r.root.deviceData), ['AAA'], `${name} did not prune the stale device`);
        assert.equal(r.scheduled, 1);
    }
});

test('a failed command is not reported as an unreadable reply', () => {
    for (const name of PARSING.map(p => p.name)) {
        const r = fire(handlerFor(name), {
            reply: '', src: SRC_FOR[name](), seed: SEED_FOR[name], code: 1, stderr: 'no such device'
        });
        assert.equal(r.threw, null, `${name} threw`);
        assert.deepEqual(r.warnings, [], `${name} reported a command failure as a parse failure`);
    }
});

test('an OpenRazer device without a battery is dropped', () => {
    const r = fireOk(handlerFor('OpenRazer battery'), {
        reply: '', src: SRC.razerId('AAA', 'misc.getBattery'),
        seed: { deviceData: { AAA: { battery: 42 } } }, code: 1, stderr: 'Error UnknownMethod misc.getBattery'
    });
    assert.equal(r.root.deviceData.AAA, undefined);
    assert.equal(r.scheduled, 1);
});

test('unpairing refreshes without reading a reply', () => {
    const handler = byTag(kde, 'Qt.callLater(root.refresh)');
    assert.equal(handler.readsReply, false);
    const r = fireOk(handler, { reply: '', src: '/usr/bin/gdbus call --session -d org.kde.kdeconnect' });
    assert.equal(r.scheduled, 1);
    assert.deepEqual(r.warnings, []);
});
