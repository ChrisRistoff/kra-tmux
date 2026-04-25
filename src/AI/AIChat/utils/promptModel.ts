import { StreamController } from '@/AI/shared/types/aiTypes';
import { getProviderApiKey, getProviderBaseURL } from '@/AI/shared/data/providers';
import OpenAI from 'openai';

const formattingRules = '\nRespond without adding chat entries, we format that on our end.';

export async function promptModel(
    provider: string,
    model: string,
    prompt: string,
    temperature: number,
    system: string,
    controller?: StreamController
): Promise<AsyncIterable<string>> {
    const apiKey = getProviderApiKey(provider);
    const baseURL = getProviderBaseURL(provider);

    const openai = new OpenAI({ apiKey, baseURL });

    return createOpenAIStream(openai, model, system, prompt, temperature, controller);
}

async function createOpenAIStream(
    openai: OpenAI,
    llmModel: string,
    system: string,
    prompt: string,
    temperature: number,
    controller?: StreamController
): Promise<AsyncIterable<string>> {
    try {
        const completion = await openai.chat.completions.create({
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt + formattingRules },
            ],
            model: llmModel,
            temperature: temperature,
            stream: true,
        });

        async function* streamResponse(): AsyncIterable<string> {
            try {
                for await (const chunk of completion) {
                    if (controller?.isAborted) {
                        break;
                    }

                    const text = chunk.choices[0]?.delta?.content ?? '';
                    yield text;
                }
            } catch (error: unknown) {
                if (controller?.isAborted) {
                    return;
                }
                throw error;
            }
        }

        return streamResponse();
    } catch (error: unknown) {
        if (controller?.isAborted) {
            throw new Error('Request aborted by user');
        }
        throw error;
    }
}
