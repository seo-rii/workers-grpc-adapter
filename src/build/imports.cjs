'use strict';

// Graph inspection has no compiler peer requirement. This scanner identifies
// literal module sites without evaluating inspected code. It is deliberately
// separate from the profile compiler's full AST and semantic validation.
function tokensFor(source, sourceType) {
    const tokens = [], groups = [], pairs = new Map(), classes = [], definitions = new Map();
    let offset = 0, lineStart = true;
    const lineTerminator = /[\r\n\u2028\u2029]/;
    const codePointAt = index => index < source.length ? String.fromCodePoint(source.codePointAt(index)) : undefined;
    const identifierStart = char => char !== undefined && /[A-Za-z_$\p{ID_Start}]/u.test(char);
    const identifierPart = char => char !== undefined && /[A-Za-z0-9_$\u200c\u200d\p{ID_Continue}]/u.test(char);
    const prefix = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do']);
    const controls = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
    const expressionPrefixes = new Set(['=', '(', '[', ',', ':', '?', '=>', '${', '...',
        '+', '-', '*', '/', '%', '**', '!', '~', '&', '|', '^', '&&', '||', '??',
        '<', '>', '==', '!=', '+=', '-=', '/=', 'return', 'throw', 'yield', 'await',
        'new', 'void', 'typeof', 'delete', 'in', 'instanceof', 'of', 'case', 'extends']);
    const previous = () => tokens[tokens.length - 1];
    const expressionBefore = index => {
        const before = tokens[index - 1];
        if (before?.value === ':' && groups[groups.length - 1]?.control === 'switch') {
            // A switch clause starts statements, while an unmatched question
            // mark makes this a conditional-expression alternate in that body.
            let alternatives = 0;
            for (let cursor = index - 2; cursor >= 0; cursor--) {
                if (pairs.get(cursor) < cursor) { cursor = pairs.get(cursor); continue; }
                const value = tokens[cursor].value;
                if (value === ':') alternatives++;
                else if (value === '?' && alternatives-- === 0) return true;
                else if ([';', '{', '}'].includes(value)) break;
            }
            return false;
        }
        // A line break after return/yield ends that expression before a new
        // declaration; comments are already absent from the token stream.
        return expressionPrefixes.has(before?.value) && !(['return', 'yield'].includes(before.value)
            && lineTerminator.test(source.slice(before.end, tokens[index].start)));
    };
    const allowsRegex = () => {
        const last = previous();
        if (!last) return true;
        if (last.kind === 'identifier') return prefix.has(last.value);
        if (['literal', 'number', 'regex', 'template-end'].includes(last.kind)) return false;
        if ([')', '}'].includes(last.value)) return last.statementEnd;
        return ![']', '++', '--', '.', '?.'].includes(last.value);
    };
    function add(kind, value, start, extra = {}) {
        lineStart = false;
        const token = { kind, value, start, end: offset, ...extra }, index = tokens.length;
        const header = classes[classes.length - 1];
        if (header?.depth === groups.length && header.stage !== 'heritage') {
            if (value === 'extends') header.stage = 'heritage';
            else if (header.stage === 'name' && kind === 'identifier') header.stage = 'body';
            else if (value !== '{') classes.pop();
        }
        if (kind === 'punctuation') {
            if (['(', '[', '{', '${'].includes(value)) {
                const last = previous();
                let statementEnd = value === '(' ? controls.has(last?.value)
                    : value === '{' && (!last || !['=', '(', '[', ',', ':', 'return'].includes(last.value));
                let functionBody = false;
                if (value === '{' && last?.value === ')') {
                    let keyword = (pairs.get(index - 1) ?? index) - 1;
                    if (tokens[keyword]?.kind === 'identifier' && tokens[keyword]?.value !== 'function') keyword--;
                    if (tokens[keyword]?.value === '*') keyword--;
                    if (tokens[keyword]?.value === 'function') {
                        functionBody = true;
                        const definition = keyword;
                        if (tokens[keyword - 1]?.value === 'async'
                            && !lineTerminator.test(source.slice(tokens[keyword - 1].end, tokens[keyword].start))) keyword--;
                        statementEnd = !expressionBefore(keyword);
                        definitions.set(definition, { expression: !statementEnd, body: index });
                    }
                }
                const definition = classes[classes.length - 1];
                if (value === '{' && definition?.depth === groups.length && !functionBody) {
                    // Keep a class header across its heritage expression. Its
                    // nested parentheses/classes/functions own their own bodies.
                    statementEnd = !definition.expression;
                    definitions.set(definition.index, { expression: definition.expression, body: index });
                    classes.pop();
                }
                groups.push({ index, value, statementEnd,
                    control: value === '(' ? last?.value : value === '{' ? last?.control : undefined });
            } else if ([')', ']', '}'].includes(value)) {
                const open = groups[groups.length - 1];
                if (open && ({ ')': ['('], ']': ['['], '}': ['{', '${'] })[value].includes(open.value)) {
                    groups.pop(); pairs.set(open.index, index); pairs.set(index, open.index);
                    token.statementEnd = open.statementEnd;
                    token.control = open.control;
                }
            }
        }
        tokens.push(token);
        if (kind === 'identifier' && value === 'class' && !['.', '?.'].includes(tokens[index - 1]?.value)) {
            classes.push({ index, depth: groups.length, stage: 'name', expression: expressionBefore(index) });
        }
    }
    function escaped() {
        const char = source[offset++];
        if (lineTerminator.test(char)) {
            if (char === '\r' && source[offset] === '\n') offset++;
            return '';
        }
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
        while (end < source.length && !lineTerminator.test(source[end])) {
            const char = source[end++];
            if (char === '\\') { end++; continue; }
            if (char === '[') characterClass = true;
            else if (char === ']') characterClass = false;
            else if (char === '/' && !characterClass) {
                while (end < source.length) {
                    const part = codePointAt(end);
                    if (!identifierPart(part)) break;
                    end += part.length;
                }
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
            if (/\s/.test(char)) {
                if (lineTerminator.test(char)) lineStart = true;
                offset++; continue;
            }
            // Annex B HTML comments belong to the Script goal. A close
            // comment may follow whitespace/comments at the start of a line,
            // but the same characters in `value --> other` are operators.
            if ((offset === 0 && source.startsWith('#!')) || (char === '/' && next === '/')
                || (sourceType === 'script' && (source.startsWith('<!--', offset)
                    || lineStart && source.startsWith('-->', offset)))) {
                while (offset < source.length && !lineTerminator.test(source[offset])) offset++;
                continue;
            }
            if (char === '/' && next === '*') {
                const end = source.indexOf('*/', offset + 2), after = end < 0 ? source.length : end + 2;
                if (lineTerminator.test(source.slice(offset, after))) lineStart = true;
                offset = after; continue;
            }
            if (char === '"' || char === "'" || char === '`') { quoted(char, depth); continue; }
            if (char === '/' && allowsRegex() && regex()) continue;
            if (identifierStart(codePointAt(offset)) || (char === '\\' && next === 'u')) {
                let value = '';
                while (offset < source.length) {
                    if (source[offset] === '\\' && source[offset + 1] === 'u') { offset++; value += escaped(); continue; }
                    const part = codePointAt(offset);
                    if (!identifierPart(part)) break;
                    value += part; offset += part.length;
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
    return { tokens, pairs, definitions };
}

function literalImports(source, declaration = false, { sourceType = 'script' } = {}) {
    const { tokens, pairs, definitions } = tokensFor(source, sourceType), imports = new Map();
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
    const expressionPrefixes = new Set(['return', 'throw', 'yield', 'await', 'new', 'delete', 'void', 'typeof', 'var', 'in', 'instanceof']);
    const expressionContinuations = new Set(['(', '[', '.', '?.', ',', '?', ':', '+', '-', '*', '/', '%', '**',
        '&', '|', '^', '&&', '||', '??', '<', '>', '=', '==', '!=', '+=', '-=', '/=', 'in', 'instanceof']);
    function lineEndsExpression(index, prefixes = expressionPrefixes) {
        const token = tokens[index], previous = tokens[index - 1];
        if (!previous || !/[\r\n\u2028\u2029]/.test(source.slice(previous.end, token.start))) return false;
        const finished = ['literal', 'number', 'regex', 'template-end'].includes(previous.kind)
            || previous.kind === 'identifier' && (!prefixes.has(previous.value) || property(index - 1))
            || [')', ']', '}', '++', '--'].includes(previous.value);
        return finished && !expressionContinuations.has(token.value) && !token.template && token.kind !== 'template-start';
    }
    const asyncArrowAt = index => {
        const first = value(index - 1) === ')' ? pairs.get(index - 1) : index - 1;
        return first !== undefined && value(first - 1) === 'async'
            && !/[\r\n\u2028\u2029]/.test(source.slice(tokens[first - 1].end, tokens[first].start));
    };
    function expressionEnd(start, asyncArrow, depth = 0) {
        if (depth > 128) throw new Error('WGA_DOCTOR_SOURCE_NESTING');
        // Sloppy Script arrows can use await/yield as ordinary identifiers.
        // Only an async arrow gives await its operator meaning; arrows cannot
        // be generators, so yield never prefixes their concise expression.
        const prefixes = new Set(expressionPrefixes);
        prefixes.delete('yield');
        if (!asyncArrow) prefixes.delete('await');
        let index = start;
        for (; index < tokens.length; index++) {
            // A concise arrow owns an AssignmentExpression, not the following
            // ASI statement. Preserve calls, operators and tagged templates
            // that continue the same expression across a line terminator.
            if (index > start && lineEndsExpression(index, prefixes)) break;
            if (value(index) === '=>' && value(index + 1) !== '{') {
                index = expressionEnd(index + 1, asyncArrowAt(index), depth + 1); continue;
            }
            if (pairs.get(index) > index) { index = pairs.get(index); continue; }
            if ([',', ';', ')', ']', '}'].includes(value(index))) break;
        }
        return index - 1;
    }
    function statementAfter(start, depth = 0) {
        if (depth > 128) throw new Error('WGA_DOCTOR_SOURCE_NESTING');
        const keyword = value(start);
        if (keyword === ';') return start + 1;
        if (keyword === '{' && pairs.has(start)) return pairs.get(start) + 1;
        if (identifier(start) && value(start + 1) === ':') return statementAfter(start + 2, depth + 1);
        if (['if', 'for', 'while', 'with', 'switch'].includes(keyword)) {
            const open = start + (keyword === 'for' && value(start + 1) === 'await' ? 2 : 1);
            if (value(open) === '(' && pairs.has(open)) {
                let next = statementAfter(pairs.get(open) + 1, depth + 1);
                if (keyword === 'if' && value(next) === 'else') next = statementAfter(next + 1, depth + 1);
                return next;
            }
        }
        if (keyword === 'do') {
            const next = statementAfter(start + 1, depth + 1), open = next + 1;
            if (value(next) === 'while' && value(open) === '(' && pairs.has(open)) {
                const end = pairs.get(open) + 1;
                return end + Number(value(end) === ';');
            }
        }
        if (keyword === 'try') {
            let next = statementAfter(start + 1, depth + 1);
            if (value(next) === 'catch') {
                const body = value(next + 1) === '(' && pairs.has(next + 1) ? pairs.get(next + 1) + 1 : next + 1;
                next = statementAfter(body, depth + 1);
            }
            if (value(next) === 'finally') next = statementAfter(next + 1, depth + 1);
            return next;
        }
        // Expression statements can contain commas and paired groups. A line
        // break ends one only when the next token cannot continue it; calls,
        // members and operators across lines remain in the same loop body.
        for (let index = start; index < tokens.length; index++) {
            const token = tokens[index], previous = tokens[index - 1];
            if (value(index) === ';') return index + 1;
            if (value(index) === '}' || value(index) === 'else' && !property(index)) return index;
            if (index > start && /[\r\n\u2028\u2029]/.test(source.slice(previous.end, token.start))) {
                if (index === start + 1 && ['return', 'break', 'continue', 'debugger'].includes(keyword)
                    || lineEndsExpression(index)) return index;
            }
            if (pairs.get(index) > index) index = pairs.get(index);
        }
        return tokens.length;
    }
    // Establish function/arrow and loop scopes before assigning any binding,
    // so declarations also shadow references earlier in their lexical scope.
    const parameters = [];
    if (!declaration) for (const [index, definition] of definitions) {
        if (value(index) !== 'class') continue;
        // A class static block has its own var environment. Visit only direct
        // class elements: nested method/initializer bodies establish their own
        // environments and must not make an ordinary block var-isolating.
        const end = pairs.get(definition.body);
        for (let member = definition.body + 1; member < end; member++) {
            if (value(member) === 'static' && value(member + 1) === '{' && pairs.has(member + 1)) {
                addScope(member + 1, pairs.get(member + 1), true);
            }
            if (pairs.get(member) > member) member = pairs.get(member);
        }
    }
    if (!declaration) for (let index = 0; index < tokens.length; index++) {
        if (value(index) === '(' && pairs.has(index)) {
            const close = pairs.get(index), body = close + 1, before = value(index - 1);
            const forLoop = before === 'for' || before === 'await' && value(index - 2) === 'for';
            if (value(body) === '{' && pairs.has(body) && !forLoop && !['if', 'while', 'with', 'switch'].includes(before)) {
                const scope = addScope(index, pairs.get(body), before !== 'catch');
                // The body block is the same function scope for var bindings.
                if (before !== 'catch') addScope(body, pairs.get(body), true);
                parameters.push({ scope, start: index + 1, end: close });
                if (before === 'catch') bind(scopeAt(body), bindings(index + 1, close));
            }
            if (forLoop) {
                addScope(index, statementAfter(body) - 1);
            }
        }
        if (value(index) === '=>') {
            const start = value(index - 1) === ')' ? pairs.get(index - 1) : index - 1;
            if (start === undefined) continue;
            const body = index + 1, end = value(body) === '{' ? pairs.get(body) : expressionEnd(body, asyncArrowAt(index));
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
    function record(kind, token, base) {
        if (token?.kind !== 'literal' || typeof token.value !== 'string' || !/^@grpc\/grpc-js(?:\/|$)/.test(token.value)) return;
        kind = declaration ? 'declaration' : kind;
        const imported = { kind, specifier: token.value, ...(base !== undefined ? { base } : {}) };
        // One source can use two createRequire bases for the same specifier.
        imports.set(JSON.stringify(imported), imported);
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
        if (identifier(cursor)) {
            names.push(value(cursor));
            if (['module', 'node:module'].includes(source)) namespaces.push(value(cursor));
            cursor++;
        }
        if (value(cursor) === ',') cursor++;
        if (value(cursor) === '*' && value(cursor + 1) === 'as') {
            names.push(value(cursor + 2));
            if (['module', 'node:module'].includes(source)) namespaces.push(value(cursor + 2));
        } else if (value(cursor) === '{' && pairs.has(cursor)) {
            for (const [first, last] of separated(cursor + 1, pairs.get(cursor))) {
                const alias = value(first + 1) === 'as' ? value(first + 2) : value(first);
                if (first < last) names.push(alias);
                if (['module', 'node:module'].includes(source) && value(first) === 'createRequire') factories.push(alias);
                if (['module', 'node:module'].includes(source) && value(first) === 'default') namespaces.push(alias);
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
            const definition = definitions.get(index);
            if (!identifier(name) || value(name) === 'extends' || !definition || !pairs.has(definition.body)) continue;
            // Scope ownership must agree with the lexer, including async
            // modifiers and class heritage that contains other definitions.
            if (definition.expression) bind(addScope(name, pairs.get(definition.body)), [value(name)]);
            else bind(scopeAt(index), [value(name)]);
        }
    }
    function unparenthesized(start, end) {
        while (value(start) === '(' && pairs.get(start) === end - 1) { start++; end--; }
        return [start, end];
    }
    function sourceURL(start, end) {
        [start, end] = unparenthesized(start, end);
        return end - start === 5 && tokens[start]?.kind === 'identifier'
            && tokens.slice(start, end).map(token => token.value).join(' ') === 'import . meta . url';
    }
    function loaderBase(open) {
        const close = pairs.get(open);
        if (close === undefined) return null;
        let [start, end] = separated(open + 1, close)[0];
        [start, end] = unparenthesized(start, end);
        if (sourceURL(start, end)) return undefined;
        if (end === start + 1 && tokens[start]?.kind === 'literal' && typeof value(start) === 'string') return { kind: 'literal', value: value(start) };
        if (value(start) === 'new' && value(start + 1) === 'URL' && bindingAt('URL', start) === undefined
            && value(start + 2) === '(' && pairs.get(start + 2) === end - 1) {
            const args = separated(start + 3, end - 1), [first, last] = unparenthesized(...args[0]);
            if (last === first + 1 && tokens[first]?.kind === 'literal' && typeof value(first) === 'string'
                && (args.length === 1 || args.length === 2 && sourceURL(...args[1]))) {
                return { kind: 'url', value: value(first), relative: args.length === 2 };
            }
        }
        // Do not execute arbitrary expressions or assume the source directory.
        return null;
    }
    function loaderAt(index) {
        const binding = bindingAt('require', index);
        if (binding === undefined) return true;
        if (!binding || typeof binding !== 'object') return false;
        let initial = binding.initial, end;
        // A wrapper around the complete call is transparent only when the
        // enclosed expression ends with that call, without another operator.
        while (value(initial) === '(' && pairs.has(initial)) {
            const close = pairs.get(initial);
            if (['(', '.'].includes(value(close + 1))) break;
            end = close;
            initial++;
        }
        let call = value(initial) === '(' ? (pairs.get(initial) ?? initial) + 1 : initial + 1;
        if (value(call) === '.' && value(call + 1) === 'createRequire') call += 2;
        if (value(call) !== '(' || end !== undefined && pairs.get(call) !== end - 1) return false;
        // Parentheses preserve an imported factory's identity. Only accept a
        // proven direct binding or a static property of the module namespace.
        let [start, last] = unparenthesized(initial, call);
        if (last === start + 1 && bindingAt(value(start), start) === 'factory') return { base: loaderBase(call) };
        if (value(last - 2) === '.' && value(last - 1) === 'createRequire') {
            [start, last] = unparenthesized(start, last - 2);
            if (last === start + 1 && bindingAt(value(start), start) === 'namespace') return { base: loaderBase(call) };
        }
        return false;
    }
    for (let index = 0; index < tokens.length; index++) {
        if (!['require', 'import'].includes(value(index)) || property(index)) continue;
        const kind = value(index) === 'require' ? 'require' : 'import';
        let call = index + 1, first = index;
        while (value(first - 1) === '(' && pairs.get(first - 1) === call) { first--; call++; }
        if (value(call) === '?.') call++;
        if (value(call) !== '(' || !pairs.has(call)) continue;
        // Parentheses around a literal do not compute a module specifier.
        // Split arguments first so import options and trailing commas retain
        // their ordinary meaning, then unwrap only the complete first one.
        const [start, end] = unparenthesized(...separated(call + 1, pairs.get(call))[0]);
        if (end !== start + 1) continue;
        const loader = kind === 'require' ? loaderAt(index) : true;
        if (!loader) continue;
        record(kind, tokens[start], typeof loader === 'object' ? loader.base : undefined);
    }
    return [...imports.values()];
}

module.exports = { literalImports };
