import { geminiModels, deepInfraModels, openAiModels, deepSeekModels } from '../data/models';
import * as keys from '@AIchat/data/keys';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { generateText } from "ai";
import OpenAI from "openai";

export async function promptModel(model: string, prompt: string, temperature: number, system: string): Promise<string> {
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

        const result = await geminiModel.generateContent(prompt);
        return result.response.text();
    }

    if (deepInfraModels[model]) {
        const deepInfra = createDeepInfra({apiKey: keys.getDeepInfraKey()});

        const res = await generateText({
            model: deepInfra(deepInfraModels[model]),
            prompt,
            maxTokens: 4096,
            temperature,
            system,
        });

        return res.text;
    }

    if (deepSeekModels[model]) {
        const openai = new OpenAI({
            baseURL: 'https://api.deepseek.com',
            apiKey: keys.getDeepSeekKey(),
        });

        const completion = await openai.chat.completions.create({
            messages: [{ role: "system", content: prompt }],
            model: deepSeekModels[model],
        });

        console.log(completion.choices[0].message.content!)
        return completion.choices[0].message.content!;
    }

    const openai = new OpenAI();
    const completion = await openai.chat.completions.create({
        model: openAiModels[model],
        messages: [
            { role: "system", content: system },
            {
                role: "user",
                content: prompt,
            },
        ],

        store: true,
    });

    return completion.choices[0].message.content!
}
