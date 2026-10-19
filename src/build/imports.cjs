'use strict';

// Graph inspection has no compiler peer requirement. This scanner identifies
// literal module sites without evaluating inspected code. It is deliberately
// separate from the profile compiler's full AST and semantic validation.
function tokensFor(source) {
    const tokens = [], groups = [], pairs = new Map();
    let offset = 0;
    const identifierStart = char => char !== undefined && /[A-Za-z_$\p{ID_Start}]/u.test(char);
    const identifierPart = char => char !== undefined && /[A-Za-z0-9_$\p{ID_Continue}]/u.test(char);
    const prefix = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do']);
    const controls = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
    const previous = () => tokens[tokens.length - 1];
    const allowsRegex = () => {
        const last = previous();
        if (!last) return true;
        if (last.kind === 'identifier') return prefix.has(last.value);
        if (['literal', 'number', 'regex', 'template-end'].includes(last.kind)) return false;
        if ([')', '}'].includes(last.value)) return last.statementEnd;
        return ![']', '++', '--', '.', '?.'].includes(last.value);
    };
    function add(kind, value, start, extra = {}) {
        const token = { kind, value, start, end: offset, ...extra }, index = tokens.length;
        if (kind === 'punctuation') {
            if (['(', '[', '{', '${'].includes(value)) {
                const last = previous();
                let statementEnd = value === '(' ? controls.has(last?.value)
                    : value === '{' && (!last || !['=', '(', '[', ',', ':', 'return'].includes(last.value));
                if (value === '{' && last?.value === ')') {
                    // A function expression ends an operand, unlike a function
                    // declaration or a control statement followed by a regex.
                    let keyword = (pairs.get(index - 1) ?? index) - 1;
                    if (tokens[keyword]?.kind === 'identifier' && tokens[keyword]?.value !== 'function') keyword--;
                    if (tokens[keyword]?.value === '*') keyword--;
                    if (tokens[keyword]?.value === 'function' && ['=', '(', '[', ',', ':', 'return', '=>'].includes(tokens[keyword - 1]?.value)) statementEnd = false;
                }
                groups.push({ index, value, statementEnd });
            } else if ([')', ']', '}'].includes(value)) {
                const open = groups[groups.length - 1];
                if (open && ({ ')': ['('], ']': ['['], '}': ['{', '${'] })[value].includes(open.value)) {
                    groups.pop(); pairs.set(open.index, index); pairs.set(index, open.index);
                    token.statementEnd = open.statementEnd;
                }
            }
        }
        tokens.push(token);
    }
    function escaped() {
        const char = source[offset++];
        if (char === '\n') return '';
        if (char === '\r') { if (source[offset] === '\n') offset++; return ''; }
        if (char === 'x' || char === 'u') {
            const braced = char === 'u' && source[offset] === '{';
            if (braced) offset++;
            const length = braced ? source.indexOf('}', offset) - offset : char === 'x' ? 2 : 4;
            const hex = source.slice(offset, offset + length);
            if (length < 1 || length > 6 || !/^[\da-f]+$/i.test(hex)) return '';
            offset += length + Number(braced);
            const point = parseInt(hex, 16);
            return point <= 0x10ffff ? String.fromCodePoint(point) : '';
        }
        if (/[0-7]/.test(char ?? '')) {
            let digits = char;
            while (digits.length < (char <= '3' ? 3 : 2) && /[0-7]/.test(source[offset] ?? '')) digits += source[offset++];
            return String.fromCharCode(parseInt(digits, 8));
        }
        return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[char] ?? char ?? '';
    }
    function quoted(quote, depth) {
        const start = offset++;
        let value = '', dynamic = false;
        while (offset < source.length) {
            const char = source[offset++];
            if (char === '\\') { value += escaped(); continue; }
            if (char === quote) {
                add(dynamic ? 'template-end' : 'literal', dynamic ? undefined : value, start, { template: quote === '`' });
                return;
            }
            if (quote === '`' && char === '$' && source[offset] === '{') {
                if (!dynamic) { add('template-start', undefined, start); dynamic = true; }
                const expression = offset++ - 1;
                add('punctuation', '${', expression);
                scan(true, depth + 1);
                if (source[offset] === '}') { const end = offset++; add('punctuation', '}', end); }
            } else value += char;
        }
        // An incomplete literal contains no executable import site.
        add('literal', undefined, start);
    }
    function regex() {
        let end = offset + 1, characterClass = false;
        while (end < source.length && !/[\r\n]/.test(source[end])) {
            const char = source[end++];
            if (char === '\\') { end++; continue; }
            if (char === '[') characterClass = true;
            else if (char === ']') characterClass = false;
            else if (char === '/' && !characterClass) {
                while (identifierPart(source[end])) end++;
                const start = offset; offset = end; add('regex', undefined, start); return true;
            }
        }
        return false;
    }
    function scan(templateExpression = false, depth = 0) {
        if (depth > 128) throw new Error('WGA_DOCTOR_SOURCE_NESTING');
        let braces = 0;
        while (offset < source.length) {
            const char = source[offset], next = source[offset + 1], start = offset;
            if (/\s/.test(char)) { offset++; continue; }
            if ((offset === 0 && source.startsWith('#!')) || (char === '/' && next === '/')) {
                while (offset < source.length && !/[\r\n]/.test(source[offset])) offset++;
                continue;
            }
            if (char === '/' && next === '*') {
                const end = source.indexOf('*/', offset + 2); offset = end < 0 ? source.length : end + 2; continue;
            }
            if (char === '"' || char === "'" || char === '`') { quoted(char, depth); continue; }
            if (char === '/' && allowsRegex() && regex()) continue;
            if (identifierStart(char) || (char === '\\' && next === 'u')) {
                let value = '';
                while (identifierPart(source[offset]) || (source[offset] === '\\' && source[offset + 1] === 'u')) {
                    if (source[offset] === '\\') { offset++; value += escaped(); }
                    else value += source[offset++];
                }
                add('identifier', value, start); continue;
            }
            if (/\d/.test(char)) {
                while (offset < source.length && /[\w.]/.test(source[offset])) offset++;
                add('number', undefined, start); continue;
            }
            if (char === '}' && templateExpression && braces === 0) return;
            if (char === '{') braces++;
            else if (char === '}') braces--;
            const operator = ['...', '=>', '?.', '++', '--', '&&', '||', '??', '==', '!=', '**', '+=', '-=', '/='].find(value => source.startsWith(value, offset));
            offset += operator?.length ?? 1;
            add('punctuation', operator ?? char, start);
        }
    }
    scan();
    return { tokens, pairs };
}

function literalImports(source, declaration = false) {
    const { tokens, pairs } = tokensFor(source), imports = new Map();
    if (!tokens.some(token => token.kind === 'literal' && typeof token.value === 'string' && /^@grpc\/grpc-js(?:\/|$)/.test(token.value))) return [];
    const value = index => tokens[index]?.value;
    const identifier = index => tokens[index]?.kind === 'identifier';
    const property = index => ['.', '?.'].includes(value(index - 1));
    const scopeRoot = { start: 0, end: tokens.length, function: true, bindings: new Map() }, scopes = [scopeRoot];
    const byRange = new Map([[`0:${tokens.length}`, scopeRoot]]);
    const addScope = (start, end, isFunction = false) => {
        const key = `${start}:${end}`, found = byRange.get(key);
        if (found) { found.function ||= isFunction; return found; }
        const scope = { start, end, function: isFunction, bindings: new Map() };
        scopes.push(scope); byRange.set(key, scope); return scope;
    };
    if (!declaration) for (let index = 0; index < tokens.length; index++) if (value(index) === '{' && pairs.has(index)) addScope(index, pairs.get(index));
    const scopeAt = (index, functionOnly = false) => scopes.filter(scope => scope.start <= index && index <= scope.end && (!functionOnly || scope.function))
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? scopeRoot;
    function separated(start, end, separator = ',') {
        const parts = []; let first = start;
        for (let index = start; index < end; index++) {
            if (pairs.get(index) > index) { index = pairs.get(index); continue; }
            if (value(index) === separator) { parts.push([first, index]); first = index + 1; }
        }
        parts.push([first, end]); return parts;
    }
    function bindings(start, end) {
        const names = [];
        for (let [first, last] of separated(start, end)) {
            if (value(first) === '...') first++;
            if (identifier(first)) names.push(value(first));
            else if (['{', '['].includes(value(first)) && pairs.has(first)) {
                const object = value(first) === '{';
                for (const [begin, finish] of separated(first + 1, Math.min(last, pairs.get(first)))) {
                    const parts = object ? separated(begin, finish, ':') : [[begin, finish]];
                    names.push(...bindings(...(parts.length > 1 ? parts[parts.length - 1] : [begin, finish])));
                }
            }
        }
        return names;
    }
    const bind = (scope, names, loader = false) => { for (const name of names) scope.bindings.set(name, loader); };
    function expressionEnd(start) {
        let index = start;
        for (; index < tokens.length; index++) {
            if (pairs.get(index) > index) { index = pairs.get(index); continue; }
            if ([',', ';', ')', ']', '}'].includes(value(index))) break;
        }
        return index - 1;
    }
    // Establish function/arrow and loop scopes before assigning any binding,
    // so declarations also shadow references earlier in their lexical scope.
    const parameters = [];
    if (!declaration) for (let index = 0; index < tokens.length; index++) {
        if (value(index) === '(' && pairs.has(index)) {
            const close = pairs.get(index), body = close + 1, before = value(index - 1);
            if (value(body) === '{' && pairs.has(body) && !['if', 'while', 'for', 'with', 'switch'].includes(before)) {
                const scope = addScope(index, pairs.get(body), before !== 'catch');
                // The body block is the same function scope for var bindings.
                if (before !== 'catch') addScope(body, pairs.get(body), true);
                parameters.push({ scope, start: index + 1, end: close });
                if (before === 'catch') bind(scopeAt(body), bindings(index + 1, close));
            }
            if (before === 'for') {
                const end = value(body) === '{' ? pairs.get(body) : expressionEnd(body);
                if (end !== undefined) addScope(index, end);
            }
        }
        if (value(index) === '=>') {
            const start = value(index - 1) === ')' ? pairs.get(index - 1) : index - 1;
            if (start === undefined) continue;
            const body = index + 1, end = value(body) === '{' ? pairs.get(body) : expressionEnd(body);
            if (end === undefined) continue;
            const scope = addScope(start, end, true);
            if (value(body) === '{') addScope(body, end, true);
            parameters.push({ scope, start: value(start) === '(' ? start + 1 : start, end: value(start) === '(' ? index - 1 : index });
        }
    }
    for (const parameter of parameters) {
        const names = bindings(parameter.start, parameter.end);
        bind(parameter.scope, names);
        // A narrower body scope must retain the enclosing parameter binding.
        for (const child of scopes) if (child.function && child.start > parameter.scope.start && child.end === parameter.scope.end) bind(child, names);
    }
    function bindingAt(name, index) {
        const owners = scopes.filter(scope => scope.start <= index && index <= scope.end && scope.bindings.has(name))
            .sort((a, b) => (a.end - a.start) - (b.end - b.start));
        return owners.length ? owners[0].bindings.get(name) : undefined;
    }
    function record(kind, token) {
        if (token?.kind !== 'literal' || typeof token.value !== 'string' || !/^@grpc\/grpc-js(?:\/|$)/.test(token.value)) return;
        kind = declaration ? 'declaration' : kind;
        imports.set(`${kind}:${token.value}`, { kind, specifier: token.value });
    }
    for (let index = 0; index < tokens.length; index++) {
        const keyword = value(index);
        if (!['import', 'export'].includes(keyword) || property(index) || value(index + 1) === '(' || value(index + 1) === '.') continue;
        if (keyword === 'import' && tokens[index + 1]?.kind === 'literal') { record('import', tokens[index + 1]); continue; }
        let from = index + 1;
        for (; from < tokens.length && ![';', '='].includes(value(from)); from++) {
            if (pairs.get(from) > from) { from = pairs.get(from); continue; }
            if (value(from) === 'from' && tokens[from + 1]?.kind === 'literal') break;
        }
        if (value(from) !== 'from' || tokens[from + 1]?.kind !== 'literal') continue;
        record('import', tokens[from + 1]);
        if (keyword !== 'import') continue;
        const source = value(from + 1), names = [], factories = [], namespaces = [];
        let cursor = index + 1;
        if (value(cursor) === 'type') cursor++;
        if (identifier(cursor)) { names.push(value(cursor)); cursor++; }
        if (value(cursor) === ',') cursor++;
        if (value(cursor) === '*' && value(cursor + 1) === 'as') {
            names.push(value(cursor + 2));
            if (['module', 'node:module'].includes(source)) namespaces.push(value(cursor + 2));
        } else if (value(cursor) === '{' && pairs.has(cursor)) {
            for (const [first, last] of separated(cursor + 1, pairs.get(cursor))) {
                const alias = value(first + 1) === 'as' ? value(first + 2) : value(first);
                if (first < last) names.push(alias);
                if (['module', 'node:module'].includes(source) && value(first) === 'createRequire') factories.push(alias);
            }
        }
        bind(scopeAt(index), names);
        bind(scopeAt(index), factories, 'factory');
        bind(scopeAt(index), namespaces, 'namespace');
    }
    if (!declaration) for (let index = 0; index < tokens.length; index++) {
        if (['const', 'let', 'var'].includes(value(index)) && !property(index)) {
            let end = index + 1;
            for (; end < tokens.length && ![';', ')', '}', 'in', 'of'].includes(value(end)); end++) {
                if (pairs.get(end) > end) end = pairs.get(end);
            }
            for (const [start, finish] of separated(index + 1, end)) {
                // A following expression after automatic semicolon insertion
                // is not another binding just because it contains a comma.
                if (identifier(start) && start + 1 < finish && !['=', ':'].includes(value(start + 1))) continue;
                const names = bindings(start, finish), assignment = separated(start, finish, '=');
                const initial = assignment.length > 1 ? assignment[1][0] : -1;
                const loader = value(start) === 'require' && initial >= 0 ? { initial } : false;
                const scope = scopeAt(index, value(index) === 'var');
                // Redeclaring the CJS wrapper parameter with an uninitialized
                // top-level var preserves its existing Node loader value.
                if (scope === scopeRoot && value(index) === 'var' && value(start) === 'require' && initial < 0) continue;
                bind(scope, names, loader);
            }
        }
        if (['function', 'class'].includes(value(index)) && !property(index)) {
            const name = value(index + 1) === '*' ? index + 2 : index + 1;
            if (!identifier(name)) continue;
            const expression = ['=', '(', '[', ',', ':', 'return', '=>'].includes(value(index - 1));
            let body = name + 1;
            if (value(body) === '(') body = (pairs.get(body) ?? body) + 1;
            if (expression && value(body) === '{' && pairs.has(body)) bind(addScope(name, pairs.get(body)), [value(name)]);
            else bind(scopeAt(index), [value(name)]);
        }
    }
    function loaderAt(index) {
        const binding = bindingAt('require', index);
        if (binding === undefined) return true;
        if (!binding || typeof binding !== 'object') return false;
        const initial = binding.initial, origin = bindingAt(value(initial), initial);
        return (origin === 'factory' && value(initial + 1) === '(')
            || (origin === 'namespace' && value(initial + 1) === '.' && value(initial + 2) === 'createRequire' && value(initial + 3) === '(');
    }
    for (let index = 0; index < tokens.length; index++) {
        if (!['require', 'import'].includes(value(index)) || property(index)) continue;
        const kind = value(index) === 'require' ? 'require' : 'import';
        let call = index + 1, first = index;
        while (value(first - 1) === '(' && pairs.get(first - 1) === call) { first--; call++; }
        if (value(call) === '?.') call++;
        if (value(call) !== '(' || ![',', ')'].includes(value(call + 2))) continue;
        if (kind === 'require' && !loaderAt(index)) continue;
        record(kind, tokens[call + 1]);
    }
    return [...imports.values()];
}

module.exports = { literalImports };
