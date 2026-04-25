import { Models, Providers } from "@/AI/shared/types/aiTypes";

const deepInfraModels: Models = {
    'DeepSeek-V4-Flash': 'deepseek-ai/DeepSeek-V4-Flash',
    'Kimi-K2': 'moonshotai/Kimi-K2.6',
    'qwent3-coder': 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    'openai/gpt-oss-20b': 'openai/gpt-oss-20b',
    'GLM-4.5': 'zai-org/GLM-4.5',
    'deepSeekR1-turbo': 'deepseek-ai/DeepSeek-R1-Turbo',
    'llama405B': 'meta-llama/Meta-Llama-3.1-405B-Instruct',
    'nemotron340B': 'nvidia/Nemotron-4-340B-Instruct',
    'deepSeekV3': 'deepseek-ai/DeepSeek-V3',
}

const geminiModels: Models = {
    'gemini-3.0-pro': 'gemini-3-pro-preview',
    'gemini-3.0-flash': 'gemini-3-flash-preview',
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

const copilotModels: Models = {
    'gpt-5-mini': 'openai/gpt-5-mini',
}

export const providers: Providers = {
    'open-router': openRouterModels,
    'deep-infra': deepInfraModels,
    'gemini': geminiModels,
    'open-ai': openAiModels,
    'deep-seek': deepSeekModels,
    'mistral': mistralModels,
    'copilot': copilotModels,
}
