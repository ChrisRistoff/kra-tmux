import { Models, Providers } from "@/AIchat/types/aiTypes";

const deepInfraModels: Models = {
    'deepSeekR1-turbo': 'deepseek-ai/DeepSeek-R1-Turbo',
    'deepSeekR1': 'deepseek-ai/DeepSeek-R1',
    'deepSeek70B': 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
    'deepSeekV3': 'deepseek-ai/DeepSeek-V3',
    'llama405B': 'meta-llama/Meta-Llama-3.1-405B-Instruct',
    'nemotron340B': 'nvidia/Nemotron-4-340B-Instruct',
}

const geminiModels: Models = {
    'gemini-2.5': 'gemini-2.5-pro-exp-03-25',
    'gemini-thinking': 'gemini-2.0-flash-thinking-exp',
    'gemini-pro': 'gemini-2.0-pro-exp',
    'gemini-flash': 'models/gemini-2.0-flash-001',
}

const openAiModels: Models = {
    'o1-mini': 'o1-mini'
}

const deepSeekModels: Models = {
    'deepSeekV3': 'deepseek-chat',
    'deepSeekR1': 'deepseek-reasoner',
}

const openRouterModels: Models = {
    'perplexity-deep-research': 'perplexity/sonar-deep-research',
    'o3-mini': 'openai/o3-mini',
    'o3-mini-high': 'openai/o3-mini-high',
    'o1-mini': 'openai/o1-mini',
    'mistral-codestral': 'mistralai/codestral-2501',
}

const mistralModels: Models = {
    'open-7x22': 'open-mixtral-8x22b',
    'large': 'mistral-large-2411',
}

export const providers: Providers = {
    'open-router': openRouterModels,
    'deep-infra': deepInfraModels,
    'gemini': geminiModels,
    'open-ai': openAiModels,
    'deep-seek': deepSeekModels,
    'mistral': mistralModels,
}
