import { readServiceToken, requireServiceToken } from '../http-security.mjs';
try {
 const external=readServiceToken('DSH_CHAT_API_TOKEN'), internal=readServiceToken('PCW_INTERNAL_TOKEN');
 requireServiceToken(external); requireServiceToken(internal);
 if (external===internal) throw Error('Use separate internal and external service tokens.');
 if (process.env.PCW_LOCAL_KEY!==external) throw Error('PCW_LOCAL_KEY must explicitly match the external service token; managed DSH credentials must match it too.');
 console.log('Local authorization references checked; no network or model request.');
} catch { console.error('Local authorization is missing or inconsistent. See SECURITY.md; no credentials printed.');process.exitCode=1; }
