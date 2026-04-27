/**
 * Fluent menu chaining for blessed-style prompts with Esc-as-back navigation.
 *
 * Each step sees everything collected so far and returns one more value.
 */

export class UserCancelled extends Error {
    constructor(message = 'User cancelled') {
        super(message);
        this.name = 'UserCancelled';
    }
}

type AnyRecord = Record<string, unknown>;
type StepFn<TIn extends AnyRecord, TValue> = (data: TIn) => TValue | Promise<TValue>;
type InternalStep = (data: AnyRecord) => Promise<AnyRecord>;

export interface MenuChain<TData extends AnyRecord> {
    step: <K extends string, TValue>(
        key: K,
        fn: StepFn<TData, TValue>
    ) => MenuChain<TData & { [P in K]: Awaited<TValue> }>;

    run: (seed?: TData) => Promise<TData>;
}

function buildChain<TData extends AnyRecord>(
    initial: TData,
    steps: ReadonlyArray<InternalStep>
): MenuChain<TData> {
    return {
        step<K extends string, TValue>(key: K, fn: StepFn<TData, TValue>) {
            return buildChain<TData & { [P in K]: Awaited<TValue> }>(
                initial as TData & { [P in K]: Awaited<TValue> },
                [
                    ...steps,
                    async (data: AnyRecord): Promise<AnyRecord> => ({
                        ...data,
                        [key]: await fn(data as TData),
                    }),
                ]
            );
        },

        async run(seed = initial): Promise<TData> {
            const snapshots: AnyRecord[] = [seed];
            let index = 0;

            while (index < steps.length) {
                try {
                    snapshots[index + 1] = await steps[index](snapshots[index]);
                    index++;
                } catch (error) {
                    if (!(error instanceof UserCancelled) || index === 0) throw error;
                    snapshots.length = index;
                    index--;
                }
            }

            return (snapshots[steps.length] ?? seed) as TData;
        },
    };
}

export function menuChain(): MenuChain<AnyRecord>;
export function menuChain<TData extends AnyRecord>(initial: TData): MenuChain<TData>;
export function menuChain<TData extends AnyRecord>(initial?: TData): MenuChain<AnyRecord> {
    return buildChain((initial ?? {}) as AnyRecord, []);
}
