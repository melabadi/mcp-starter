import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OneNoteComClient, type OneNoteComRunner } from '../src/onenote-com.ts';
import { MAX_PAGE_TEXT, OneNoteError, parseAllowedNotebookIds } from '../src/onenote.ts';

test('COM configuration needs only an explicit notebook allowlist, not Graph credentials', () => {
  assert.deepEqual(parseAllowedNotebookIds({ ONENOTE_ALLOWED_NOTEBOOK_IDS: '["demo"]' }), ['demo']);
  for (const value of ['', '[]', '["same","same"]', '[1]', 'null']) {
    assert.throws(() => parseAllowedNotebookIds({ ONENOTE_ALLOWED_NOTEBOOK_IDS: value }), OneNoteError);
  }
});

test('COM client scopes calls and pagination to an approved notebook and section', async () => {
  let calls = 0;
  const run: OneNoteComRunner = async (request) => {
    calls++;
    assert.deepEqual(request.allowedNotebookIds, ['demo']);
    if (request.action === 'notebooks') return { notebooks: [{ id: 'demo', displayName: 'Demo' }] };
    assert.equal(request.notebookId, 'demo');
    if (request.action === 'sections') return {
      sections: [{ id: 'b', displayName: 'B' }, { id: 'a', displayName: 'A' }],
    };
    return { pages: [{ id: 'page', title: 'Welcome' }] };
  };
  const client = new OneNoteComClient(['demo'], run);
  assert.deepEqual(await client.listNotebooks(), [{ id: 'demo', displayName: 'Demo' }]);
  const first = await client.listSections('demo', 1);
  assert.deepEqual(first.sections, [{ id: 'a', displayName: 'A' }]);
  assert.ok(first.nextCursor);
  assert.deepEqual(await client.listSections('demo', 1, first.nextCursor), {
    sections: [{ id: 'b', displayName: 'B' }], nextCursor: null,
  });
  assert.deepEqual(await client.listPages('demo', 'a', 100), {
    pages: [{ id: 'page', title: 'Welcome' }], nextCursor: null,
  });
  const before = calls;
  for (const action of [
    () => client.listSections('outside', 10),
    () => client.listPages('outside', 'a', 10),
    () => client.readPage('outside', 'page'),
    () => client.listSections('demo', 101),
    () => client.listSections('demo', 10, 'invalid'),
    () => client.listPages('demo', 'a', 10, first.nextCursor!),
  ]) {
    await assert.rejects(action, OneNoteError);
  }
  assert.equal(calls, before);
});

test('COM page extraction is bounded, excludes active HTML, and never fetches links', async () => {
  const client = new OneNoteComClient(['demo'], async (request) => {
    assert.equal(request.action, 'page');
    assert.equal(request.pageId, 'page');
    return {
      id: 'page', title: 'Welcome',
      html: '<div>Hello COM.</div><script>hidden</script><style>hidden</style>'
        + '<img src="https://invalid.example/private"><div>'
        + '<span>x</span>'.repeat(MAX_PAGE_TEXT) + '</div>',
    };
  });
  const result = await client.readPage('demo', 'page');
  assert.ok(result.text.startsWith('Hello COM.'));
  assert.ok(result.text.length <= MAX_PAGE_TEXT);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.text, /hidden|invalid\.example/u);
});

test('COM client rejects malformed, missing, extra and mismatched source results', async () => {
  for (const notebooks of [
    [], [{ id: 'outside', displayName: 'Outside' }], [{ displayName: 'Missing ID' }],
  ]) {
    const client = new OneNoteComClient(['demo'], async () => ({ notebooks }));
    await assert.rejects(client.listNotebooks(), OneNoteError);
  }
  const client = new OneNoteComClient(['demo'], async () => ({ id: 'other', title: '', html: '' }));
  await assert.rejects(client.readPage('demo', 'page'), /different page/u);
  const unavailable = new OneNoteComClient(['demo'], async () => {
    throw new OneNoteError('OneNote COM: Desktop unavailable.');
  });
  await assert.rejects(unavailable.listNotebooks(), /Desktop unavailable/u);
});

test('OneNote preserves the readable prefix of a single paragraph at and beyond the text limit', async () => {
  for (const length of [MAX_PAGE_TEXT, MAX_PAGE_TEXT + 1, MAX_PAGE_TEXT + 1000]) {
    const client = new OneNoteComClient(['demo'], async () => ({
      id: 'page', title: 'Long paragraph', html: `<div>${'x'.repeat(length)}</div>`,
    }));
    const page = await client.readPage('demo', 'page');
    assert.equal(page.text, 'x'.repeat(MAX_PAGE_TEXT));
    assert.equal(page.truncated, length > MAX_PAGE_TEXT);
  }
});

const bridgeHarness = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$global:oneNoteTestFake = [PSCustomObject]@{}
$global:oneNoteTestFake | Add-Member -MemberType ScriptMethod -Name GetHierarchy -Value {
    param($id, $scope, $output, $schema)
    if ($env:COM_TEST_CASE -eq 'oversized') {
        $output.Value = 'x' * (1MB + 1)
        return
    }
    $output.Value = '<one:Notebook xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote" ID="approved" name="Demo">' +
        '<one:Section ID="section" name="General"><one:Page ID="page" name="Welcome"/></one:Section>' +
        '<one:SectionGroup><one:Section ID="nested" name="Nested"/></one:SectionGroup>' +
        '<one:SectionGroup isInRecycleBin="true"><one:Section ID="deleted" name="Deleted"/></one:SectionGroup>' +
        '</one:Notebook>'
}
$global:oneNoteTestFake | Add-Member -MemberType ScriptMethod -Name GetPageContent -Value {
    param($id, $output, $info, $schema)
    [Console]::Error.WriteLine('content-requested')
    $pageId = if ($env:COM_TEST_CASE -eq 'mismatch') { 'different' } else { 'page' }
    $output.Value = '<one:Page xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote" ID="' +
        $pageId + '"><one:Outline><one:OEChildren><one:OE><one:T><![CDATA[Hello COM.]]>' +
        '</one:T></one:OE></one:OEChildren></one:Outline></one:Page>'
}
function New-Object {
    param([string]$ComObject)
    if ($ComObject -ne 'OneNote.Application') { throw 'Unexpected COM object.' }
    return $global:oneNoteTestFake
}
$parameters = @{ Action=$env:COM_TEST_ACTION; NotebookId='approved'; SectionId='section'; PageId='page' }
if ($env:COM_TEST_CASE -eq 'outside-page') { $parameters.PageId='outside' }
if ($env:COM_TEST_CASE -eq 'outside-section') { $parameters.SectionId='outside' }
& $env:COM_TEST_BRIDGE @parameters
`;

test('native PowerShell bridge handles one-item JSON arrays and verifies membership before reading', async (context) => {
  const commands = process.platform === 'win32'
    ? [join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'pwsh']
    : ['pwsh'];
  const invalidConfigurations: Record<string, string> = {
    scalar: '"approved"', empty: '[]', duplicates: '["approved","approved"]',
  };
  for (const command of commands) {
    for (const [scenario, action] of [
      ['notebooks', 'notebooks'], ['sections', 'sections'], ['pages', 'pages'], ['page', 'page'],
      ['outside-page', 'page'], ['outside-section', 'pages'], ['mismatch', 'page'], ['oversized', 'notebooks'],
      ['scalar', 'notebooks'], ['empty', 'notebooks'], ['duplicates', 'notebooks'],
    ] as const) {
      await context.test(`${command === 'pwsh' ? 'PowerShell 7' : 'Windows PowerShell 5.1'}: ${scenario}`, () => {
        const result = spawnSync(command, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
          '-EncodedCommand', Buffer.from(bridgeHarness, 'utf16le').toString('base64'),
        ], {
          env: {
            ...process.env,
            COM_TEST_BRIDGE: fileURLToPath(new URL('../scripts/onenote-com.ps1', import.meta.url)),
            COM_TEST_CASE: scenario, COM_TEST_ACTION: action,
            ONENOTE_ALLOWED_NOTEBOOK_IDS: invalidConfigurations[scenario] ?? '["approved"]',
          },
          encoding: 'utf8', timeout: 15_000,
        });
        assert.ifError(result.error);
        if (['notebooks', 'sections', 'pages', 'page'].includes(scenario)) {
          assert.equal(result.status, 0, result.stderr);
          const response = JSON.parse(result.stdout.replace(/^\uFEFF/u, ''));
          if (scenario === 'notebooks') assert.deepEqual(response, { notebooks: [{ id: 'approved', displayName: 'Demo' }] });
          if (scenario === 'sections') assert.deepEqual(response.sections.map((section: { id: string }) => section.id), ['section', 'nested']);
          if (scenario === 'pages') assert.deepEqual(response, { pages: [{ id: 'page', title: 'Welcome' }] });
          if (scenario === 'page') assert.equal(response.html, '<div>Hello COM.</div>');
        } else {
          assert.notEqual(result.status, 0);
          assert.equal(result.stdout, '');
          assert.match(result.stderr, /OneNote COM:/u);
          if (scenario.startsWith('outside-')) assert.doesNotMatch(result.stderr, /content-requested/u);
        }
      });
    }
  }
});
