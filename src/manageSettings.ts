import { runDynamicSettings } from '@/UI/dynamicSettings/render';

export async function handleChangeSettings(): Promise<void> {
    await runDynamicSettings();
}

