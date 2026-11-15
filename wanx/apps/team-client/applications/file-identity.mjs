import {constants} from 'node:fs';
import {open} from 'node:fs/promises';

// Windows path stat/lstat may report dev=0 while fstat returns the volume ID.
// A short-lived read-only handle supplies a full comparable identity; callers
// retain their separate no-link path evidence before and after reading.
export async function fileIdentity(filename){
 const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{return await handle.stat();}finally{await handle.close();}
}
