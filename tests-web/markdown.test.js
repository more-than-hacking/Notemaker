const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const md = C.markdownToHtml;
// No tag other than the renderer's own allow-list may appear, and no event-handler attribute.
const ALLOWED = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'mark', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
    'a', 'img', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'input']);
function assertSafe(html) {
    const tags = html.match(/<\/?([a-z0-9]+)/gi) || [];
    for (const t of tags) assert.ok(ALLOWED.has(t.replace(/[</]/g, '').toLowerCase()), 'unexpected tag ' + t + ' in ' + html);
    // attribute values are quoted and escaped by the renderer, so drop them before looking for attributes
    const attrsOnly = html.replace(/"[^"]*"/g, '""');
    assert.doesNotMatch(attrsOnly, /<[^>]*\son[a-z]+\s*=/i, 'event handler attribute in ' + html);
    assert.doesNotMatch(html, /<[^>]*\s(style|srcdoc|formaction)\s*=\s*"[^"]*(expression|javascript)/i);
    assert.doesNotMatch(html, /(href|src)\s*=\s*"\s*(javascript|vbscript|data:text)/i, 'dangerous URL in ' + html);
}

test('raw HTML and <script> are escaped', () => {
    const h = md('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a href="javascript:alert(1)">x</a>');
    assertSafe(h);
    assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('javascript:, vbscript:, data: links are not linked', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'vbscript:x', 'data:text/html;base64,PHNjcmlwdD4=', 'java\tscript:alert(1)', '&#106;avascript:alert(1)']) {
        const h = md('[click](' + url + ')');
        assertSafe(h);
        assert.doesNotMatch(h, /<a /, url);
    }
});

test('onerror / quote breaking in image and link URLs', () => {
    const cases = [
        '![x](x" onerror="alert(1))', '![x](https://a.com/x.png" onerror="alert(1))', '[x](https://a.com/"onmouseover="alert(1))',
        '![a" onerror="alert(1)](https://a.com/x.png)', '[<img src=x onerror=alert(1)>](https://a.com)', '![x](javascript:alert(1))',
        '![x](data:image/svg+xml;base64,PHN2Zz4=)', '`<script>`', '```\n<script>alert(1)</script>\n```', '| <b onclick=x> | b |\n|---|---|\n| <i> | x |',
        '**<svg onload=alert(1)>**', '> <iframe src=javascript:alert(1)>', '- [ ] <style>*{}</style>', '[[2026-11-15]]"><script>', 'https://a.com/"><script>alert(1)</script>'
    ];
    for (const c of cases) assertSafe(md(c));
    assert.match(md('![a" onerror="alert(1)](https://a.com/x.png)'), /alt="a&quot; onerror=&quot;alert\(1\)"/);
});

test('allowed links and images render', () => {
    assert.match(md('[site](https://example.com)'), /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer nofollow">site<\/a>/);
    assert.match(md('[mail](mailto:a@b.c)'), /<a href="mailto:a@b.c"/);
    assert.match(md('![pic](https://example.com/a.png)'), /<img src="https:\/\/example.com\/a.png" alt="pic"/);
    assert.match(md('![dot](data:image/png;base64,iVBORw0KGgo=)'), /<img src="data:image\/png;base64,iVBORw0KGgo="/);
    assert.match(md('see [[2026-11-14]]'), /<a href="#2026-11-14" class="wikilink" data-date="2026-11-14">2026-11-14<\/a>/);
});

test('markdown features from v1 still render', () => {
    const h = md('# H1\n## H2\n### H3\n**b** *i* ~~s~~ `c`\n\n- a\n  - b\n1. one\n\n> quote\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```');
    for (const frag of ['<h1>H1</h1>', '<h2>H2</h2>', '<h3>H3</h3>', '<strong>b</strong>', '<em>i</em>', '<del>s</del>', '<code>c</code>',
        '<ul><li>a<ul><li>b</li></ul></li></ul>', '<ol><li>one</li></ol>', '<blockquote><p>quote</p></blockquote>', '<hr>', '<th>A</th>', '<td>2</td>', '<pre><code>code</code></pre>']) {
        assert.ok(h.includes(frag), 'missing ' + frag + ' in ' + h);
    }
});

test('wiki links, backlinks and templates', () => {
    const notes = {
        '2026-11-14': { markdown: 'see [[2026-11-15]]', locked: false },
        '2026-11-13': { markdown: '', locked: true, cipher: {} },
        '2026-11-12': { markdown: 'nothing', locked: false }
    };
    assert.deepEqual(C.backlinks(notes, '2026-11-15'), ['2026-11-14']);
    assert.deepEqual(C.wikiLinks('a [[2026-11-01]] b [[2026-13-01]] [[2026-11-01]]'), ['2026-11-01']);
    assert.equal(C.applyTemplate('# {{weekday}}, {{date}}', '2026-11-15'), '# Sunday, November 15, 2026');
    const r = C.appendReview('note', { wins: 'shipped', blockers: '', focus: 'tests\nrelease' });
    assert.equal(r, 'note\n\n## Daily review\n\n**Wins**\n- shipped\n\n**Blockers**\n- —\n\n**Tomorrow\'s focus**\n- tests\n- release\n');
});

test('search covers tasks, subtasks, tags and unlocked notes only', () => {
    const doc = C.normalizeDoc({
        tasks: [{ id: 't1', title: 'Write report', date: '2026-11-15', tags: ['work'], subtasks: [{ id: 's', title: 'report charts' }] }],
        notes: {
            '2026-11-14': { markdown: 'The report is due', locked: false },
            '2026-11-13': { markdown: '', locked: true, cipher: { salt: 'a', iv: 'b', ct: 'c' } }
        }
    });
    const r = C.search(doc, 'report');
    assert.deepEqual(r.map((g) => g.date), ['2026-11-15', '2026-11-14']);
    assert.deepEqual(r[0].items.map((i) => i.kind), ['task', 'subtask']);
    assert.equal(C.search(doc, '#work')[0].items[0].taskId, 't1');
    assert.deepEqual(C.search(doc, ''), []);
});
