import { dynamicSettingsDashboard } from '@/UI/dynamicSettings/dashboard';

export async function handleChangeSettings(): Promise<void> {
    await dynamicSettingsDashboard();
}

