import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {makeScopes}=createRequire(import.meta.url)('../plugin/index.cjs');
test('server full identity remains isolated at long tails and rejects separator injection',()=>{
 const user={profile:{handle:'synthetic'}},salt=Buffer.alloc(32),common='x'.repeat(512);
 assert.notDeepEqual(makeScopes(user,'world',common+'A',salt),makeScopes(user,'world',common+'B',salt));
 for(const [world,chat]of[['a\0b','c'],['a','b\0c']])assert.throws(()=>makeScopes(user,world,chat,salt));
 assert.notDeepEqual(makeScopes(user,'world','chat',salt),makeScopes({profile:{handle:'other'}},'world','chat',salt));
});
