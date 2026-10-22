// Reviewed Git blob bytes and their exact CRLF checkout representation.
// Both hashes are fixed from PR29; runtime does NOT normalize arbitrary SQL.
// No Git/network at runtime.
// A new migration source needs a separately reviewed catalog change.
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const reviewed={
  "kind": "REVIEWED_MIGRATION_SOURCE_V1",
  "sourceCommit": "043ba56ee716f044698a6de66f079a7c7bae8753",
  "sourceTree": "4e5eeda2d4781719af3e543d5eeaef62de342df0",
  "files": [
    {
      "name": "0002_live.sql",
      "sha256": "674a5d8c49841a4a9fb5bcecaea272a3a9820cc02c19b9d7365882718309934b",
      "crlfSha256": "b0941097b217608744926e45c1b8413278e4fa26d205f85484624ef517df3248"
    },
    {
      "name": "0003_observed_capacity.sql",
      "sha256": "145d85958d73fc36e2f2cb7a1c05391b5bb2a2db699dc9df2f4795ad63367984",
      "crlfSha256": "ba4b753986d997108e01f2be6995cbeda16cd88c5bafba5a74ea1539ab8f98b9"
    },
    {
      "name": "0005_reviewed_free_recovery.sql",
      "sha256": "d7615f5739981d251215ee7629391fcc3f1011d083005cba40cacc037bc4d244",
      "crlfSha256": "4d34e54ee8885f04be71bf60c4a0680f6570f2e6127d02113d624e2d6b78a735"
    },
    {
      "name": "0006_unknown_groq_probe.sql",
      "sha256": "5cb9403c17b00665cdc74934026ac5eb290690c3ded9857c640ff1e53eabe4a8",
      "crlfSha256": "ed179b28e6876ab67d014ab7e6269c9313671bd3391750807207dc84b6efc882"
    },
    {
      "name": "0007_bounded_free_batch.sql",
      "sha256": "623768de14a3185719f1a52af145faae42a978b55d004ee47f0950a668803abc",
      "crlfSha256": "adcf117566dd7f94e8ff8d346a4e6b6f9571d3d0da888e517c652c8310642870"
    },
    {
      "name": "0008_paid_summary_budget.sql",
      "sha256": "57e43ab71973ab2d3c278e3a128036fbfcd2fc4460e8535942d4cec723527621",
      "crlfSha256": "7c1102b4ee1d47e1ef2f830f697d32736948064183893f36df647d6bc3f9b63f"
    },
    {
      "name": "0009_paid_first_trial.sql",
      "sha256": "0ffbf0a8bbc00da7bbdd2a6d4ffa5790f18df589a30b0043119f3b79f6fee536",
      "crlfSha256": "cde59b767a87719993f634e4d3196f80484e1ebf3976dbbf2700353a11e70e65"
    },
    {
      "name": "0010_paid_summary_receipts.sql",
      "sha256": "120d7706e2c36bf353efe4bd8d2c4e006178c06794fb3babe0a106767e00c71d",
      "crlfSha256": "d3c2a28a80e4ae2f68759d740c37da957c528b02c5575562367a1a98b6bced2d"
    },
    {
      "name": "0015_gemini_two_pass.sql",
      "sha256": "5f1a76b82d36b7daa93311a9ab1ab8d9a5711a3728fa401597635f9ae793dc90",
      "crlfSha256": "69912fc8dc931b093fc964aab2f00da2aa1922eff21dc790a76d4dc0e98e1f63"
    },
    {
      "name": "0016_full_coverage_write_lock.sql",
      "sha256": "77ebb47143a039321ed4c633b4e9797752687255db122349865495cdf7866054",
      "crlfSha256": "ede4883af66f3b0af5f1569da42289482c9657120587f6171ce7120a3a17bb53"
    },
    {
      "name": "0017_audio_submission_idempotency.sql",
      "sha256": "c12cd20409517c6d6154a23f53f15383a53a70e3f193e0205b10cab862b146dd",
      "crlfSha256": "3b9756b05e6ca94e0017245d0e8d81cbd4f0ad914dd5866371ee04b02d3e9fb5"
    },
    {
      "name": "0018_local_runner_outbox.sql",
      "sha256": "dd8efdcbc36823c65da2127481313a3aa13fa3adbc52a6e72a04dd26b970fd62",
      "crlfSha256": "e4317560eeb508d9cd488a32c18d29835309bf4656c62230070ca4d5c91926a1"
    },
    {
      "name": "0019_local_runner_audio_bridge.sql",
      "sha256": "9d64ebb59a2d948ed63a43704cf51977bca5a3f11ed57eb9ff0ee9f12eaa6336",
      "crlfSha256": "7d6073477a3c358120ee6866b1d955a3a088de7e1dd34ae8cde430feafd4cc83"
    },
    {
      "name": "0020_local_runner_blocked_resume.sql",
      "sha256": "c26d29418a85121b7a0a770d2261a0f57a98eb342a0fa450066a360a312783ff",
      "crlfSha256": "a1e0b09aa47852196147e1173b6971a4af7b9324e2454be9c155070cacbf7b24"
    }
  ]
};
const directory=resolve(import.meta.dirname,'../migrations');
export function reviewedMigrationSource(){return structuredClone(reviewed);}
export function matchesReviewedMigrationSource(observed){
 if(JSON.stringify(observed)!==JSON.stringify(reviewed))return false;
 try{
  const files=readdirSync(directory,{withFileTypes:true}).filter(file=>file.name.endsWith('.sql')).sort((a,b)=>a.name.localeCompare(b.name));
  if(files.length!==reviewed.files.length)return false;
  return files.every((file,index)=>file.isFile()&&file.name===reviewed.files[index].name
   &&[reviewed.files[index].sha256,reviewed.files[index].crlfSha256].includes(createHash('sha256').update(readFileSync(resolve(directory,file.name))).digest('hex')));
 }catch{return false;}
}
