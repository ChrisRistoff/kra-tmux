import * as keys from '@AI/data/keys';

export async function test(): Promise<void> {
    console.log(keys.getClaudeKey());
    console.log(keys.getDeepSeekKey());
}

