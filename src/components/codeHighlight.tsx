import type { ReactNode } from 'react';

// Syntax coloring of the code viewer ("{}") and the Pine editor: comments, strings, colors,
// numbers, keywords, ta. / math. / input. calls (classes tk-* in App.css)

export type CodeLang = 'pine' | 'ts';

const KEYWORDS: Record<CodeLang, RegExp> = {
  pine: /^(if|else|for|to|by|while|var|varip|and|or|not|true|false|na|switch|import|export|method|type|break|continue)$/,
  ts: /^(import|export|from|const|let|var|function|return|if|else|for|while|of|in|new|type|as|true|false|null|undefined|this|typeof|break|continue)$/,
};
const TOKEN = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(#[0-9a-fA-F]{6,8}\b)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w.]*)/g;

export function highlightLine(line: string, lang: CodeLang): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(line.slice(last, i));
    const [text, comment, str, color, num, word] = m;
    let cls = '';
    if (comment) cls = 'tk-comment';
    else if (str) cls = 'tk-string';
    else if (color) cls = 'tk-color';
    else if (num) cls = 'tk-number';
    else if (word && KEYWORDS[lang].test(word)) cls = 'tk-keyword';
    else if (word && /^(ta|math|input|color|plot|hline|indicator|strategy|str|array)(\.|$)/.test(word)) cls = 'tk-builtin';
    out.push(cls ? <span key={i} className={cls}>{text}</span> : text);
    last = i + text.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}
