import * as keys from '@AIchat/data/keys';
import OpenAI from "openai";

export async function promptModel(provider: string, model: string, prompt: string, temperature: number, system: string): Promise<AsyncIterable<any> | string> {
    let apiKey;
    let baseURL;

    switch (provider) {
        case 'deep-infra':
            apiKey = keys.getDeepInfraKey();
            baseURL = "https://api.deepinfra.com/v1/openai";
            break;
        case 'deep-seek':
            apiKey = keys.getDeepSeekKey();
            baseURL = 'https://api.deepseek.com';
            break;
        case 'open-router':
            apiKey = keys.getOpenRouterKey();
            baseURL = 'https://openrouter.ai/api/v1';
            break;
        case 'gemini':
            apiKey = keys.getGeminiKey();
            baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
            break;
        case 'open-ai':
        default:
            break;
    }

    let openai;

    if (provider === 'gemini') {
        openai = new OpenAI({
            apiKey,
            baseURL,
        })
    }

    if (provider === 'deep-infra') {
        openai = new OpenAI({
            apiKey,
            baseURL,
        });
    }

    if (provider === 'deep-seek') {
        openai = new OpenAI({
            baseURL,
            apiKey,
        });
    }

    if (provider === 'open-router') {
        openai = new OpenAI({
            baseURL,
            apiKey,
        })
    }

    if (!openai) {
        openai = new OpenAI();
    }

    return createOpenAIStream(openai, model, system, prompt, temperature);
}

async function createOpenAIStream(
    openai: OpenAI,
    llmModel: string,
    system: string,
    prompt: string,
    temperature: number
): Promise<AsyncIterable<any>> {
    const completion = await openai.chat.completions.create({
        messages: [
            { role: "system", content: system },
            { role: "user", content: prompt + '\n' + 'chat entries are added by us, do not add your own chat entry above your response.'},
        ],
        model: llmModel,
        temperature: temperature,
        stream: true,
    });

    async function* streamResponse() {
        for await (const chunk of completion) {
            const text = chunk.choices[0]?.delta?.content || '';
            yield {
                text: () => text
            };
        }
    }

    return streamResponse();
}
