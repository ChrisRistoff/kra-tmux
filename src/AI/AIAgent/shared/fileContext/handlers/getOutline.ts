import { formatOutline, getFileOutline } from '../../utils/fileOutline';
import { errorContent, textContent, ToolResult } from '../toolResult';

export async function handleGetOutline(filePath: string): Promise<ToolResult> {
    try {
        const outline = await getFileOutline(filePath);

        return textContent(formatOutline(filePath, outline));
    } catch (err) {
        return errorContent(`Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    }
}
