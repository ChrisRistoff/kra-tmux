import { menuChain, UserCancelled } from '@/UI/menuChain';

describe('menuChain', () => {
    it('returns the seed when no steps are chained', async () => {
        const result = await menuChain({ source: 'seed' }).run();
        expect(result).toEqual({ source: 'seed' });
    });

    it('builds one object across chained steps', async () => {
        const result = await menuChain()
            .step('provider', () => 'deepinfra')
            .step('model', (data) => `${data.provider}-gemini`)
            .step('temperature', () => 10)
            .run();

        expect(result).toEqual({
            provider: 'deepinfra',
            model: 'deepinfra-gemini',
            temperature: 10,
        });
    });

    it('passes seeded data into the first step', async () => {
        const result = await menuChain({ prompt: 'hi' })
            .step('shout', (data) => data.prompt.toUpperCase())
            .run();

        expect(result).toEqual({ prompt: 'hi', shout: 'HI' });
    });

    it('rethrows non-UserCancelled errors immediately', async () => {
        const boom = new Error('boom');

        await expect(
            menuChain()
                .step('a', () => 1)
                .step('b', () => {
                    throw boom;
                })
                .run()
        ).rejects.toBe(boom);
    });

    it('propagates UserCancelled when thrown from the first step', async () => {
        await expect(
            menuChain()
                .step('a', () => {
                    throw new UserCancelled();
                })
                .run()
        ).rejects.toBeInstanceOf(UserCancelled);
    });

    it('re-runs the previous step with its original snapshot after Esc', async () => {
        const calls: string[] = [];
        let stepB = 0;
        let stepC = 0;

        const result = await menuChain()
            .step('a', (data) => {
                calls.push(`a(${JSON.stringify(data)})`);

                return 'A';
            })
            .step('b', (data) => {
                calls.push(`b(${JSON.stringify(data)})`);
                stepB++;

                return stepB === 1 ? 'B1' : 'B2';
            })
            .step('c', (data) => {
                calls.push(`c(${JSON.stringify(data)})`);
                stepC++;
                if (stepC === 1) {
                    throw new UserCancelled();
                }

                return 'C';
            })
            .run();

        expect(result).toEqual({ a: 'A', b: 'B2', c: 'C' });
        expect(calls).toEqual([
            'a({})',
            'b({"a":"A"})',
            'c({"a":"A","b":"B1"})',
            'b({"a":"A"})',
            'c({"a":"A","b":"B2"})',
        ]);
    });

    it('supports backtracking across an arbitrarily long chain', async () => {
        const runs = [0, 0, 0, 0];
        const escAtStep: Record<number, number[]> = { 0: [], 1: [2], 2: [2], 3: [1] };

        const result = await menuChain()
            .step('s0', () => ++runs[0])
            .step('s1', () => {
                if (escAtStep[1].includes(++runs[1])) {
                    throw new UserCancelled();
                }

                return runs[1];
            })
            .step('s2', () => {
                if (escAtStep[2].includes(++runs[2])) {
                    throw new UserCancelled();
                }

                return runs[2];
            })
            .step('s3', () => {
                if (escAtStep[3].includes(++runs[3])) {
                    throw new UserCancelled();
                }

                return runs[3];
            })
            .run();

        expect(result).toEqual({ s0: 2, s1: 3, s2: 3, s3: 2 });
        expect(runs).toEqual([2, 3, 3, 2]);
    });
});