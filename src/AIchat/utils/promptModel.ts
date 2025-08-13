import * as keys from '@/AIchat/data/keys';
import { Mistral } from '@mistralai/mistralai';
import OpenAI from "openai";

const formattingRules = '\nRespond without adding chat entries, we format that on our end.';

export async function promptModel(provider: string, model: string, prompt: string, temperature: number, system: string): Promise<AsyncIterable<string>> {
    let apiKey;
    let baseURL;

    switch (provider) {
        case 'deep-infra':
            apiKey = keys.getDeepInfraKey();
            baseURL = "https://api.deepinfra.com/v1/openai";
            break;
        case 'deep-seek':
            apiKey = keys.getDeepSeekKey();
            baseURL = 'https://api.deepseek.com/v1';
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

    if (provider === 'mistral') {
        return createMistralStream(prompt, system, model);
    }

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
): Promise<AsyncIterable<string>> {
    const completion = await openai.chat.completions.create({
        messages: [
            { role: "system", content: system },
            { role: "user", content: prompt + formattingRules},
        ],
        model: llmModel,
        temperature: temperature,
        stream: true,
    });

    async function* streamResponse() {
        for await (const chunk of completion) {
            const text = chunk.choices[0]?.delta?.content || '';
            yield text;
        }
    }

    return streamResponse();
}

async function createMistralStream(prompt: string, system: string, model: string): Promise<AsyncIterable<string>> {
    const client = new Mistral({apiKey: keys.getMistralKey()});

    async function* streamResponse() {
        const stream = await client.chat.stream({
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt + formattingRules },
            ],
            stream: true,
        });

        for await (const chunk of stream) {
            const content = chunk.data?.choices[0]?.delta?.content;
            const text = typeof content === 'string' ? content : content?.join('');
            yield text ?? '';
        }
    }

    return streamResponse();
}
