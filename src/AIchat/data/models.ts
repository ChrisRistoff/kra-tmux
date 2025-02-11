import { Models } from "../types/aiTypes";

export const modelsThatAddAnEmptyLineAtTheEnd = ['gemini-flash'];

export const deepInfraModels: Models = {
    'deepSeek70B': 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
    'deepSeekR1': 'deepseek-ai/DeepSeek-R1',
    'deepSeekV3': 'deepseek-ai/DeepSeek-V3',
    'llama405B': 'meta-llama/Meta-Llama-3.1-405B-Instruct',
    'nemotron340B': 'nvidia/Nemotron-4-340B-Instruct',
}

export const geminiModels: Models = {
    'gemini-thinking': 'gemini-2.0-flash-thinking-exp',
    'gemini-flash': 'models/gemini-2.0-flash-001',
}

export const openAiModels: Models = {
    // 'o1-mini-openAI': 'o1-mini'
}

export const deepSeekModels: Models = {
    // 'deepSeekV3': 'deepseek-chat',
    // 'deepSeekR1': 'deepseek-reasoner',
}

export const openRouter: Models = {
    'mistral-codestral': 'mistralai/codestral-2501',
    'o1-mini-openRouter': 'openai/o1-mini'
}
