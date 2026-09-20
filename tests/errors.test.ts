import {expect,it} from 'vitest';
import {geminiFailure} from '../src/errors';
it('classifies upstream failures without leaking secrets',()=>{
 for(const [status,category] of [[503,'upstream_unavailable'],[429,'quota_or_rate_limit'],[403,'upstream_auth'],[400,'request_or_model']] as const){
  const result=geminiFailure({status,message:'secret-key and private prompt',headers:{authorization:'secret-key'}});
  expect(result.category).toBe(category);expect(result.upstream_status).toBe(status);expect(JSON.stringify(result)).not.toContain('secret-key');
 }
 expect(geminiFailure({name:'APIConnectionTimeoutError'}).category).toBe('timeout');
 expect(geminiFailure(null).upstream_status).toBe(null);
});
