'use strict';

// Graph inspection has no compiler peer requirement. This scanner identifies
// literal module sites without evaluating inspected code. It is deliberately
// separate from the profile compiler's full AST and semantic validation.
function tokensFor(source, sourceType) {
    const tokens = [], groups = [], pairs = new Map(), classes = [], definitions = new Map(), arrows = [];
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
    const memberAt = index => tokens[index - 1]?.kind === 'punctuation' && ['.', '?.', '#'].includes(tokens[index - 1].value);
    const context = () => {
        const group = groups.findLast(group => group.context), arrow = arrows[arrows.length - 1];
        return arrow && arrow.index > (group?.index ?? -1) ? arrow.context
            : group?.context ?? { await: sourceType === 'module', yield: false };
    };
    const arrowContext = index => {
        const first = tokens[index - 1]?.value === ')' ? pairs.get(index - 1) : index - 1;
        return { await: tokens[first - 1]?.value === 'async'
            && !lineTerminator.test(source.slice(tokens[first - 1].end, tokens[first].start)), yield: false };
    };
    function functionContext(index) {
        let name = index - 1;
        if (tokens[name]?.kind === 'punctuation' && tokens[name].value === ']') name = pairs.get(name);
        if (tokens[name - 1]?.value === '#') name--;
        const parent = tokens[groups[groups.length - 1]?.index];
        if (['object', 'class'].includes(parent?.container) && !memberAt(name)
            && (['identifier', 'literal', 'number'].includes(tokens[name]?.kind) || ['[', '#'].includes(tokens[name]?.value))) {
            let modifier = name - 1;
            const generator = tokens[modifier]?.value === '*';
            if (generator) modifier--;
            const async = tokens[modifier]?.value === 'async'
                && !lineTerminator.test(source.slice(tokens[modifier].end, tokens[name].start));
            if (async) modifier--;
            if (['get', 'set', 'static'].includes(tokens[modifier]?.value)) modifier--;
            if (modifier === groups[groups.length - 1].index || [',', ';', '}'].includes(tokens[modifier]?.value)
                || parent.container === 'class' && tokens[modifier]
                    && lineTerminator.test(source.slice(tokens[modifier].end, tokens[modifier + 1].start))) {
                return { await: async, yield: generator, method: true };
            }
        }
        let keyword = name;
        if (tokens[keyword]?.kind === 'identifier' && tokens[keyword]?.value !== 'function') keyword--;
        const generator = tokens[keyword]?.value === '*';
        if (generator) keyword--;
        if (tokens[keyword]?.value === 'function' && !memberAt(keyword)) {
            return { await: tokens[keyword - 1]?.value === 'async'
                && !lineTerminator.test(source.slice(tokens[keyword - 1].end, tokens[keyword].start)), yield: generator };
        }
    }
    const expressionBefore = (index, start = tokens[index]?.start ?? offset) => {
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
            && lineTerminator.test(source.slice(before.end, start)));
    };
    const allowsRegex = () => {
        const last = previous();
        if (!last) return true;
        if (last.kind === 'identifier') {
            // Keywords used as property names end an expression just like any
            // other member. A following slash divides; it cannot start a regexp.
            if (memberAt(tokens.length - 1)) return false;
            if (lineTerminator.test(source.slice(last.end, offset))) {
                // debugger and restricted jumps end before a slash on the
                // next line. A jump's label belongs to it only on the same
                // line; qualified/private property names remain expressions.
                let statement = tokens.length - 1;
                if (!['debugger', 'break', 'continue'].includes(last.value)) {
                    const jump = tokens[statement - 1];
                    statement = ['break', 'continue'].includes(jump?.value)
                        && !lineTerminator.test(source.slice(jump.end, last.start)) ? statement - 1 : -1;
                }
                if (statement >= 0 && !['.', '?.', '#'].includes(tokens[statement - 1]?.value)) return true;
            }
            return ['await', 'yield', 'of'].includes(last.value) ? last.operator : prefix.has(last.value);
        }
        if (['literal', 'number', 'regex', 'template-end'].includes(last.kind)) return false;
        if ([')', '}'].includes(last.value)) return last.statementEnd;
        return ![']', '++', '--', '.', '?.'].includes(last.value);
    };
    function add(kind, value, start, extra = {}) {
        lineStart = false;
        const token = { kind, value, start, end: offset, ...extra }, index = tokens.length;
        // Concise arrows own an AssignmentExpression. Delimiters and an ASI
        // statement restore the containing function's await/yield grammar.
        while (arrows.length) {
            const arrow = arrows[arrows.length - 1], last = previous();
            if (groups.length > arrow.depth) break;
            const finished = last && (['literal', 'number', 'regex', 'template-end'].includes(last.kind)
                || last.kind === 'identifier' && !(last.operator ?? prefix.has(last.value))
                || [')', ']', '}', '++', '--'].includes(last.value));
            const asi = finished && lineTerminator.test(source.slice(last.end, start)) && !token.template
                && (kind === 'identifier' && !['in', 'instanceof'].includes(value)
                    || ['literal', 'number'].includes(kind));
            if (groups.length < arrow.depth || kind === 'punctuation' && ([',', ';', ')', ']', '}'].includes(value)
                || value === ':' && !arrow.conditionals) || asi) arrows.pop();
            else {
                if (kind === 'punctuation') {
                    if (value === '?') arrow.conditionals++;
                    else if (value === ':') arrow.conditionals--;
                }
                break;
            }
        }
        if (kind === 'identifier' && ['await', 'yield'].includes(value)) token.operator = context()[value];
        const parent = groups[groups.length - 1];
        if (parent?.control === 'for' && parent.value === '(') {
            if (value === ';') parent.iteration = true;
            if (value === 'in' && !memberAt(index)) parent.iteration = true;
            if (value === 'of') {
                const last = previous();
                token.operator = !parent.iteration && !memberAt(index)
                    && (last?.kind === 'identifier' && !['let', 'const', 'var'].includes(last.value)
                        || [')', ']', '}'].includes(last?.value));
                if (token.operator) parent.iteration = true;
            }
        }
        const header = classes[classes.length - 1];
        if (header?.depth === groups.length && header.stage !== 'heritage') {
            if (value === 'extends') header.stage = 'heritage';
            else if (header.stage === 'name' && kind === 'identifier') header.stage = 'body';
            else if (value !== '{') classes.pop();
        }
        if (kind === 'punctuation') {
            if (['(', '[', '{', '${'].includes(value)) {
                const last = previous();
                token.parent = groups[groups.length - 1]?.index;
                if (value === '{') token.container = last?.value !== '=>' && (expressionBefore(index, start)
                    || last?.value === 'default' && tokens[index - 2]?.value === 'export') ? 'object' : 'block';
                let control;
                if (value === '(' && last?.kind === 'identifier' && !memberAt(index - 1)) {
                    if (controls.has(last.value)) control = last.value;
                    else if (last.value === 'await' && tokens[index - 2]?.kind === 'identifier'
                        && tokens[index - 2].value === 'for' && !memberAt(index - 2)) control = 'for';
                } else if (value === '{') control = last?.control;
                let statementEnd = value === '(' ? !!control
                    : value === '{' && (!last || !['=', '(', '[', ',', ':', 'return'].includes(last.value));
                let scope;
                if (value === '(') scope = functionContext(index);
                else if (value === '{' && last?.value === ')') scope = last.context;
                else if (value === '{' && last?.value === '=>') scope = arrowContext(index - 1);
                if (value === '[' && tokens[parent?.index]?.container === 'class') {
                    let before = index - 1;
                    while (['static', 'async', 'get', 'set', '*'].includes(tokens[before]?.value)) before--;
                    let bareField = before;
                    if (tokens[bareField]?.kind === 'punctuation' && tokens[bareField].value === ']') bareField = pairs.get(bareField);
                    if (['identifier', 'literal', 'number'].includes(tokens[bareField]?.kind) || tokens[bareField]?.value === '[') {
                        bareField--;
                        if (tokens[bareField]?.value === '#') bareField--;
                        if (tokens[bareField]?.value === 'static') bareField--;
                    }
                    const boundary = cursor => {
                        if (cursor === parent.index) return true;
                        if (tokens[cursor]?.kind !== 'punctuation') return false;
                        if (tokens[cursor].value === ';') return true;
                        const body = pairs.get(cursor), head = tokens[body - 1];
                        return tokens[cursor]?.value === '}' && tokens[body]?.parent === parent.index
                            && (head?.context?.method || head?.value === 'static');
                    };
                    // Computed class names run in the containing scope. Field
                    // initializers and method bodies have their own grammar;
                    // an initializer's continued `array[index]` is not a name.
                    if (boundary(before) || boundary(bareField) && tokens[before]
                        && lineTerminator.test(source.slice(tokens[before].end, start))) {
                        scope = tokens[parent.index].outerContext;
                    }
                }
                let functionBody = false;
                if (value === '{' && last?.value === ')') {
                    let keyword = (pairs.get(index - 1) ?? index) - 1;
                    if (tokens[keyword]?.kind === 'identifier' && tokens[keyword]?.value !== 'function') keyword--;
                    if (tokens[keyword]?.value === '*') keyword--;
                    // A property named function can be called before an ASI
                    // block; it does not turn that block into a function body.
                    if (tokens[keyword]?.value === 'function' && !['.', '?.'].includes(tokens[keyword - 1]?.value)) {
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
                    token.container = 'class';
                    token.outerContext = context();
                    scope = { await: false, yield: false };
                    classes.pop();
                }
                groups.push({ index, value, statementEnd, control, context: scope });
            } else if ([')', ']', '}'].includes(value)) {
                const open = groups[groups.length - 1];
                if (open && ({ ')': ['('], ']': ['['], '}': ['{', '${'] })[value].includes(open.value)) {
                    groups.pop(); pairs.set(open.index, index); pairs.set(index, open.index);
                    token.statementEnd = open.statementEnd;
                    token.control = open.control;
                    token.context = open.context;
                }
            }
        }
        tokens.push(token);
        if (kind === 'punctuation' && value === '=>') arrows.push({ index, depth: groups.length, context: arrowContext(index), conditionals: 0 });
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

function literalImports(source, declaration = false, { includeLocal = false, sourceType = 'script' } = {}) {
    const { tokens, pairs, definitions } = tokensFor(source, sourceType), imports = new Map();
    const included = specifier => typeof specifier === 'string' && (/^@grpc\/grpc-js(?:\/|$)/.test(specifier)
        || includeLocal && /^(?:\.{1,2}\/|\/|file:|#)/.test(specifier));
    if (!tokens.some(token => token.kind === 'literal' && included(token.value))) return [];
    const value = index => tokens[index]?.value;
    const identifier = index => tokens[index]?.kind === 'identifier';
    const property = index => tokens[index - 1]?.kind === 'punctuation' && ['.', '?.'].includes(value(index - 1));
    const calls = [];
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
        if (end === start + 1 && tokens[start]?.kind === 'literal' && included(value(start))) {
            calls.push({ index, kind, token: tokens[start] });
        }
    }
    // Generated peers can contain thousands of local-looking path constants.
    // Only an actual candidate import site needs the expensive scope analysis.
    // Static imports/re-exports put their literal immediately after import/from.
    if (!calls.length && !tokens.some((token, index) => token.kind === 'literal' && included(token.value)
        && ['import', 'from'].includes(value(index - 1)))) return [];
    const scopeRoot = { start: 0, end: tokens.length, function: true, bindings: new Map() }, scopes = [scopeRoot];
    const byRange = new Map([[`0:${tokens.length}`, scopeRoot]]);
    scopeRoot.parameters = new Set(sourceType === 'script' ? ['exports', 'require', 'module', '__filename', '__dirname'] : []);
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
            if (tokens[index].kind === 'punctuation' && value(index) === separator) { parts.push([first, index]); first = index + 1; }
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
                    // Only the binding pattern declares names. A default value
                    // can contain a conditional ':' which is not a property alias.
                    const [patternStart, patternEnd] = separated(begin, finish, '=')[0];
                    const parts = object ? separated(patternStart, patternEnd, ':') : [[patternStart, patternEnd]];
                    names.push(...bindings(...parts[parts.length - 1]));
                }
            }
        }
        return names;
    }
    const bind = (scope, names, loader = false, lexical = false) => {
        for (const name of names) scope.bindings.set(name, loader);
        if (lexical) {
            scope.lexicals ??= new Set();
            for (const name of names) scope.lexicals.add(name);
        }
    };
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
        let index = start, conditionals = 0;
        for (; index < tokens.length; index++) {
            // A concise arrow owns an AssignmentExpression, not the following
            // ASI statement. Preserve calls, operators and tagged templates
            // that continue the same expression across a line terminator.
            if (index > start && lineEndsExpression(index, prefixes)) break;
            if (value(index) === '=>' && value(index + 1) !== '{') {
                index = expressionEnd(index + 1, asyncArrowAt(index), depth + 1); continue;
            }
            if (pairs.get(index) > index) { index = pairs.get(index); continue; }
            // A colon closes this arrow only when it belongs to the containing
            // conditional. Nested conditionals still belong to its body.
            if (tokens[index].kind === 'punctuation') {
                if (value(index) === '?') conditionals++;
                else if (value(index) === ':') {
                    if (conditionals === 0) break;
                    conditionals--;
                }
            }
            if ([',', ';', ')', ']', '}'].includes(value(index))) break;
        }
        return index - 1;
    }
    function statementAfter(start, depth = 0) {
        if (depth > 128) throw new Error('WGA_DOCTOR_SOURCE_NESTING');
        const keyword = value(start);
        if (keyword === ';') return start + 1;
        if (keyword === '{' && pairs.has(start)) return pairs.get(start) + 1;
        const definition = definitions.get(start);
        if (definition && !definition.expression && pairs.has(definition.body)) return pairs.get(definition.body) + 1;
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
    const functionBodies = new Set([...definitions].filter(([index]) => value(index) === 'function').map(([, definition]) => definition.body));
    const conditionalFunctions = new Set(), conditionalVars = [];
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
            if (sourceType === 'script' && before === 'if' && !property(index - 1)) {
                const after = statementAfter(body);
                for (const branch of [body, ...(value(after) === 'else' ? [after + 1] : [])]) {
                    const definition = value(branch) === 'function' && definitions.get(branch);
                    if (!definition || definition.expression || !pairs.has(definition.body)) continue;
                    // Annex B treats an unbraced function branch as a block.
                    // Its lexical name must not shadow the following statement.
                    addScope(branch, pairs.get(definition.body));
                    conditionalFunctions.add(branch);
                }
            }
            // Parameters belong to actual function definitions, direct object/
            // class methods, or a catch clause. A call followed by an ASI block
            // has none of these contexts, even if its callee is named catch.
            const method = tokens[body]?.container === 'block'
                && ['object', 'class'].includes(tokens[tokens[index].parent]?.container)
                && (identifier(index - 1) || ['literal', 'number'].includes(tokens[index - 1]?.kind) || before === ']');
            const catchClause = before === 'catch' && !property(index - 1) && !method;
            const forLoop = !method && !property(index - 1)
                && (before === 'for' || before === 'await' && value(index - 2) === 'for');
            if (value(body) === '{' && pairs.has(body) && (functionBodies.has(body) || method || catchClause)) {
                const scope = addScope(index, pairs.get(body), !catchClause);
                // The body block is the same function scope for var bindings.
                if (!catchClause) addScope(body, pairs.get(body), true);
                parameters.push({ scope, start: index + 1, end: close });
                // Annex B permits a same-name var through a simple catch
                // identifier, but a destructured catch binding blocks it.
                if (catchClause) bind(scopeAt(body), bindings(index + 1, close), false, !identifier(index + 1));
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
        parameter.scope.parameters = new Set(names);
        // A narrower body scope must retain the enclosing parameter binding.
        for (const child of scopes) if (child.function && child.start > parameter.scope.start && child.end === parameter.scope.end) {
            bind(child, names);
            child.parameters = new Set(names);
        }
    }
    function bindingAt(name, index) {
        const owners = scopes.filter(scope => scope.start <= index && index <= scope.end && scope.bindings.has(name))
            .sort((a, b) => (a.end - a.start) - (b.end - b.start));
        return owners.length ? owners[0].bindings.get(name) : undefined;
    }
    function record(kind, token, base) {
        if (token?.kind !== 'literal' || !included(token.value)) return;
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
        // `type` is also a legal JavaScript default binding, including the
        // combined `type, { ... }` and `type, * as ...` import clauses.
        if (value(cursor) === 'type' && cursor + 1 < from && value(cursor + 1) !== ',') cursor++;
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
    const iterationBindings = new Set();
    if (!declaration) for (let index = 0; index < tokens.length; index++) {
        if (['const', 'let', 'var'].includes(value(index)) && !property(index)) {
            let end = index + 1;
            for (; end < tokens.length && ![';', ')', '}', 'in', 'of'].includes(value(end)); end++) {
                if (pairs.get(end) > end) end = pairs.get(end);
            }
            const iterationBinding = ['in', 'of'].includes(value(end)) && value(index - 1) === '('
                && (value(index - 2) === 'for' || value(index - 2) === 'await' && value(index - 3) === 'for');
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
                if (scope === scopeRoot && value(index) === 'var' && value(start) === 'require' && initial < 0) {
                    // A for-in/of body runs after its iteration assignment.
                    // Keep the loader before/in the RHS and after the loop:
                    // an empty iterable never overwrites the wrapper value.
                    if (iterationBinding) {
                        const body = pairs.get(index - 1) + 1;
                        const iteration = addScope(body, statementAfter(body) - 1);
                        bind(iteration, names);
                        iterationBindings.add(iteration);
                    }
                    continue;
                }
                bind(scope, names, loader, value(index) !== 'var');
                // The iteration assignment is not a lexical declaration. A
                // later var initializer in this body can restore a loader.
                if (scope === scopeRoot && value(index) === 'var' && loader) {
                    for (const iteration of iterationBindings) {
                        if (iteration.start <= index && index <= iteration.end) bind(iteration, names, loader);
                    }
                }
            }
        }
        if (['function', 'class'].includes(value(index)) && !property(index)) {
            const name = value(index + 1) === '*' ? index + 2 : index + 1;
            const definition = definitions.get(index);
            if (!identifier(name) || value(name) === 'extends' || !definition || !pairs.has(definition.body)) continue;
            // Scope ownership must agree with the lexer, including async
            // modifiers and class heritage that contains other definitions.
            if (definition.expression) bind(addScope(name, pairs.get(definition.body)), [value(name)], false, value(index) === 'class');
            else {
                bind(scopeAt(index), [value(name)], false, value(index) === 'class');
                if (conditionalFunctions.has(index)) {
                    // The legacy outer var is suppressed by a matching formal
                    // parameter, including the CommonJS wrapper's require.
                    const owner = scopeAt(index, true);
                    if (!owner.parameters?.has(value(name))) conditionalVars.push({ owner, name: value(name), declaration: index });
                }
            }
        }
    }
    // A lexical declaration can suppress the Annex B copy, and an existing
    // var already owns the name. Keep their collected loader provenance.
    for (const { owner, name, declaration } of conditionalVars) {
        const blocked = scopes.some(scope => scope.start >= owner.start && scope.end <= owner.end
            && scope.start < declaration && declaration <= scope.end && scope.lexicals?.has(name));
        if (!blocked && !owner.bindings.has(name)) bind(owner, [name]);
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
    for (const { index, kind, token } of calls) {
        const loader = kind === 'require' ? loaderAt(index) : true;
        if (!loader) continue;
        record(kind, token, typeof loader === 'object' ? loader.base : undefined);
    }
    return [...imports.values()];
}

module.exports = { literalImports };
