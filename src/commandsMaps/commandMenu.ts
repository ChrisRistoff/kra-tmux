import { searchSelectAndReturnFromArray } from '@/UI/generalUI';
import { CommandCatalog, CommandDefinition, MenuOption } from '@/commandsMaps/types/commandTypes';

function renderMenuDetails<T extends string>(item: string, option: MenuOption<T>, usagePrefix?: string): string {
    const usage = usagePrefix ? `${usagePrefix} ${item}` : item;
    const details = option.details ?? option.description;
    const highlights = option.highlights ?? [];

    return [
        `{cyan-fg}selected{/cyan-fg}     {bold}${item}{/bold}`,
        `{yellow-fg}summary{/yellow-fg}      ${option.description}`,
        '',
        `{green-fg}what it does{/green-fg}`,
        details,
        ...(highlights.length > 0
            ? ['', `{magenta-fg}key features{/magenta-fg}`, ...highlights.map((highlight) => ` {blue-fg}-{/blue-fg} ${highlight}`)]
            : []),
        '',
        `{cyan-fg}run{/cyan-fg}          ${usage}`,
    ].join('\n');
}

export function getCommandDefinition<T extends string>(
    commands: CommandCatalog<T>,
    commandName?: string,
): CommandDefinition | null {
    if (!commandName) {
        return null;
    }

    return (commands as Partial<Record<string, CommandDefinition>>)[commandName] ?? null;
}

export async function pickMenuOption<T extends string>(opts: {
    title: string;
    header: string;
    invalidValue?: string;
    invalidLabel: string;
    usagePrefix?: string;
    options: readonly MenuOption<T>[];
}): Promise<T> {
    const optionsByName = new Map(opts.options.map((option) => [option.name, option]));
    const selected = await searchSelectAndReturnFromArray({
        prompt: opts.title,
        header: opts.invalidValue
            ? `${opts.header}\n\n${opts.invalidValue} is not a valid ${opts.invalidLabel}.`
            : opts.header,
        itemsArray: opts.options.map((option) => option.name),
        details: (item) => renderMenuDetails(item, optionsByName.get(item as T) ?? { name: item as T, description: '' }, opts.usagePrefix),
        detailsUseTags: true,
        showDetailsPanel: true,
    });

    return selected as T;
}

export async function resolveCommandSelection<T extends string>(opts: {
    title: string;
    header: string;
    invalidValue?: string;
    invalidLabel: string;
    commands: CommandCatalog<T>;
}): Promise<CommandDefinition> {
    const existing = getCommandDefinition(opts.commands, opts.invalidValue);
    if (existing) {
        return existing;
    }

    const selected = await pickMenuOption({
        title: opts.title,
        header: opts.header,
        ...(opts.invalidValue ? { invalidValue: opts.invalidValue } : {}),
        invalidLabel: opts.invalidLabel,
        usagePrefix: opts.title,
        options: (Object.entries(opts.commands) as Array<[T, CommandDefinition]>).map(([name, definition]) => ({
            name,
            description: definition.description,
            ...(definition.details ? { details: definition.details } : {}),
            ...(definition.highlights ? { highlights: definition.highlights } : {}),
        })),
    });

    return opts.commands[selected];
}
