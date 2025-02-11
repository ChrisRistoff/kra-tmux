import { geminiModels, deepInfraModels, openAiModels, deepSeekModels, openRouter } from '../data/models';
import * as keys from '@AIchat/data/keys';
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

export async function promptModel(model: string, prompt: string, temperature: number, system: string): Promise<AsyncIterable<any> | string> {
    if (geminiModels[model]) {
        const genAI = new GoogleGenerativeAI(keys.getGeminiKey());
        const geminiModel = genAI.getGenerativeModel({
            model: geminiModels[model],
            generationConfig: {
                temperature,
            },
            systemInstruction: system,
            tools: [
                {
                    codeExecution: {},
                }
            ]
        });

        const result = await geminiModel.generateContentStream(prompt);
        return result.stream;
    }

    let openai;
    let llmModel;

    if (deepInfraModels[model]) {
        openai = new OpenAI({
            apiKey: keys.getDeepInfraKey(),
            baseURL: "https://api.deepinfra.com/v1/openai",
        });

        llmModel = deepInfraModels[model];
    }

    if (deepSeekModels[model]) {
        openai = new OpenAI({
            baseURL: 'https://api.deepseek.com',
            apiKey: keys.getDeepSeekKey(),
        });

        llmModel = deepSeekModels[model];
    }

    if (openRouter[model]) {
        openai = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: keys.getOpenRouterKey(),
        })

        llmModel = openRouter[model];
    }

    // no match, default to openAI
    if (!openai) {
        openai = new OpenAI();
        llmModel = openAiModels[model];
    }

    return createOpenAIStream(openai, llmModel!, system, prompt, temperature);
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
            { role: "user", content: prompt },
        ],
        model: llmModel,
        temperature: temperature,
        stream: true,
    });

    async function* streamResponse() {
        for await (const chunk of completion) {
            const text = chunk.choices[0]?.delta?.content || '';
            yield {
                text: () => text // mimic chunk.text()
            };
        }
    }

    return streamResponse();
}
