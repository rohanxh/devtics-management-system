import type { ReactNode } from 'react';

/**
 * Minimal, safe Markdown → React renderer (headings, paragraphs, lists, quotes, code, rules, bold,
 * italics, inline code, links). It never produces raw HTML, so content cannot inject scripts.
 * ponytail: covers the KB's needs; swap for a full CommonMark renderer + sanitizer if tables/images are needed.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const safe = /^(https?:\/\/|\/|#|mailto:)/i.test(href) ? href : undefined;
      out.push(safe ? <a key={k} href={safe} target={safe.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">{label}</a> : <span key={k}>{label}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2], `h${k}`);
      blocks.push(level === 1 ? <h1 key={k++}>{content}</h1> : level === 2 ? <h2 key={k++}>{content}</h2> : <h3 key={k++}>{content}</h3>);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { blocks.push(<hr key={k++} className="my-4 border-slate-200" />); i++; continue; }
    if (line.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k++}>{inline(q.join(' '), `q${k}`)}</blockquote>);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const lis = items.map((it, j) => {
        const box = /^\[( |x)\]\s+(.*)$/i.exec(it);
        return <li key={j}>{box ? <><input type="checkbox" disabled checked={box[1].toLowerCase() === 'x'} className="mr-1.5 align-middle" aria-label="checklist item" />{inline(box[2], `li${k}-${j}`)}</> : inline(it, `li${k}-${j}`)}</li>;
      });
      blocks.push(ordered ? <ol key={k++}>{lis}</ol> : <ul key={k++}>{lis}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s+)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++}>{inline(para.join(' '), `p${k}`)}</p>);
  }
  return <div className="prose-sm-custom text-sm text-slate-800">{blocks}</div>;
}
