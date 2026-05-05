export const TOOLS = [
    {
        name: 'get_outline',
        description: 'Returns an outline (function/class/method names + line numbers) of a source file. Use to find the smallest range containing your target, then read_lines/read_function to fetch it.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
            },
            required: ['file_path'],
        },
    },

    {
        name: 'read_lines',
        description: 'Returns specific lines from a file (1-indexed, inclusive); each prefixed with its line number for use as an anchor. Up to 150 lines per call; larger reads on structured files are bounced back to get_outline (unstructured files are never gated). Hard cap 500 lines (summed across ranges). Supports multiple ranges via parallel startLines/endLines arrays — prefer that over multiple calls.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                start_line: { type: 'number', description: 'First line to return (1-indexed). Single-range only.' },
                end_line: { type: 'number', description: 'Last line to return (1-indexed, inclusive). Single-range only.' },
                startLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Start lines for multiple ranges. Must be the same length as endLines.',
                },
                endLines: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'End lines for multiple ranges. Must be the same length as startLines.',
                },
            },
            required: ['file_path'],
        },
    },

    {
        name: 'read_function',
        description: 'Returns the full body of a named function/class/method. Convenience wrapper; for TS/JS/Python/Go you can usually use read_lines on the outline range directly. Useful when the outline only has start lines.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                function_name: { type: 'string', description: 'Name of the function, class, or method to return.' },
            },
            required: ['file_path', 'function_name'],
        },
    },

    {
        name: 'anchor_edit',
        description: [
            'Anchor-based file editor. Each edit has an `op` (replace/insert/delete) and an `anchor` — contiguous lines copied verbatim from the file that uniquely identify the location.',
            'replace: swaps anchor block (or anchor..end_anchor range) for `content` (use "" to delete). insert: adds `content` before/after anchor (anchor preserved). delete: removes anchor block / range.',
            'Anchors must match EXACTLY ONCE; widen with adjacent lines if ambiguous. Whitespace is significant, but a strict miss is retried with trimmed whitespace and accepted if that gives exactly one match. Blank anchors rejected.',
            'For ranges, anchor and end_anchor must each match once and end_anchor must come at or after anchor.',
            'Multi-edit: pass several edits; resolved against the original file in parallel (overlaps rejected) and applied bottom-to-top.',
            'Examples: replace single line → { op:"replace", anchor:"const TIMEOUT_MS = 5000;", content:"const TIMEOUT_MS = 30000;" }.',
            'Replace multi-line region → { op:"replace", anchor:"function oldImpl() {", end_anchor:"} // oldImpl", content:"function newImpl() {\\n    return doIt();\\n}" }.',
            'Insert after import → { op:"insert", anchor:"import { foo } from \'./foo\';", position:"after", content:"import { bar } from \'./bar\';" }.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
                edits: {
                    type: 'array',
                    minItems: 1,
                    description: 'One or more edits to apply atomically. Resolved against the original file in parallel; rejected as a group if any anchor is missing/ambiguous or any two edits overlap.',
                    items: {
                        type: 'object',
                        properties: {
                            op: {
                                type: 'string',
                                enum: ['replace', 'insert', 'delete'],
                                description: '"replace" swaps the anchored region for `content`; "insert" adds `content` next to the anchor without removing it; "delete" removes the anchored region.',
                            },
                            anchor: {
                                type: 'string',
                                description: 'One or more contiguous lines copied verbatim from the file that uniquely identify the edit location. Multiple lines are joined with \\n. Must match exactly once.',
                            },
                            end_anchor: {
                                type: 'string',
                                description: 'Optional. replace/delete only. Upgrades the edit to a range whose end is also content-verified. Must match exactly once and appear at or after `anchor`.',
                            },
                            position: {
                                type: 'string',
                                enum: ['before', 'after'],
                                description: 'Insert only. Whether `content` goes immediately before or after the anchor block. Default "after".',
                            },
                            content: {
                                type: 'string',
                                description: 'Required for replace/insert. The text to write in (replace) or to add (insert). May span multiple lines; do NOT include surrounding context lines that are not actually changing.',
                            },
                        },
                        required: ['op', 'anchor'],
                    },
                },
            },
            required: ['file_path', 'edits'],
        },
    },

    {
        name: 'create_file',
        description: 'Creates a NEW file (refuses if the path already exists; use anchor_edit to modify existing files). Parent directories are created automatically; writes are atomic.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file to create.' },
                content: { type: 'string', description: 'Full content to write to the file.' },
            },
            required: ['file_path', 'content'],
        },
    },

    {
        name: 'search',
        description: 'Unified file finder + content grep (ripgrep, respects .gitignore). Use for exact symbol/string/path lookups; for conceptual discovery prefer `semantic_search`. Provide name_pattern (glob), content_pattern (regex), or both. Results annotated with file line counts so you can choose read_lines vs get_outline.',
        inputSchema: {
            type: 'object',
            properties: {
                name_pattern: {
                    type: 'string',
                    description: 'Glob to filter by file name/path (e.g. "**/*.ts", "src/AI/**/auth*"). At least one of name_pattern or content_pattern must be provided.',
                },
                content_pattern: {
                    type: 'string',
                    description: 'Ripgrep regex to search file contents. At least one of name_pattern or content_pattern must be provided.',
                },
                path: {
                    type: 'string',
                    description: 'Optional. Root directory to search from. Defaults to the current working directory.',
                },
                type: {
                    type: 'string',
                    description: 'Optional. Ripgrep --type alias to restrict by language (e.g. "ts", "py", "go").',
                },
                case_insensitive: {
                    type: 'boolean',
                    description: 'Optional. Case-insensitive content match. Default false.',
                },
                context: {
                    type: 'number',
                    description: 'Optional. Lines of context (-C N) around each content match. Ignored unless content_pattern is set. Default 0.',
                },
                multiline: {
                    type: 'boolean',
                    description: 'Optional. Allow content_pattern to match across line boundaries. Ignored unless content_pattern is set. Default false.',
                },
                max_results: {
                    type: 'number',
                    description: 'Optional. Cap on results: file count for name-only searches, match-line count for content searches. Default 50, hard cap 200.',
                },
            },
            required: [],
            anyOf: [
                { required: ['name_pattern'] },
                { required: ['content_pattern'] },
            ],
        },
    },

    {
        name: 'lsp_query',
        description: 'Queries a Language Server (selected by file extension via [lsp.*] in settings.toml) for hover, definition, references, implementations, type definitions, or document_symbols. Position is (line, col) or (line, symbol); both 1-indexed. document_symbols needs only file_path. First call per language pays startup + indexing cost.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Absolute or workspace-relative path to the file.',
                },
                op: {
                    type: 'string',
                    enum: ['hover', 'definition', 'references', 'implementation', 'type_definition', 'document_symbols'],
                    description: 'The LSP operation to perform.',
                },
                line: {
                    type: 'number',
                    description: 'Target line (1-indexed). Required for everything except document_symbols.',
                },
                col: {
                    type: 'number',
                    description: 'Target column (1-indexed). Provide either col or symbol.',
                },
                symbol: {
                    type: 'string',
                    description: 'Symbol text to scan for on the target line. Used when col is omitted; resolves to the column of the first occurrence.',
                },
                occurrence: {
                    type: 'number',
                    description: 'Optional. Which occurrence of symbol on the line to use (1-indexed). Default 1.',
                },
                include_declaration: {
                    type: 'boolean',
                    description: 'Optional. references only — include the declaration itself in the results. Default true.',
                },
            },
            required: ['file_path', 'op'],
        },
    },
];

