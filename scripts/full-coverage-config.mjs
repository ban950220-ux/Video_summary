// Fail-closed lexical gate for the two activation names in wrangler.toml.
// It intentionally accepts one narrow spelling instead of attempting to
// normalize every TOML key/table form. Any other active occurrence is denied.
const withoutComment=line=>{
 let quoted=null,escaped=false;
 for(let i=0;i<line.length;i++){
  const char=line[i];
  if(quoted){
   if(quoted==='"'&&escaped){escaped=false;continue;}
   if(quoted==='"'&&char==='\\'){escaped=true;continue;}
   if(char===quoted)quoted=null;
  }else if(char==='"'||char==="'")quoted=char;
  else if(char==='#')return line.slice(0,i);
 }
 return line;
};

export function inspectFullCoverageConfig(config){
 if(typeof config!=='string')throw Error('FULL_COVERAGE_CONFIG_INVALID');
 let section=null,enabled=false,varsSeen=false;
 for(const original of config.split(/\r?\n/)){
  const line=withoutComment(original).trim();
  if(!line)continue;
  // Basic quoted TOML keys can encode any protected key using Unicode escapes.
  // This deployment config has no need for them; deny instead of decoding only
  // some alternative key spellings.
  if(/\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/.test(line))throw Error('FULL_COVERAGE_CONFIG_INVALID');
  const header=line.match(/^\[([^\]]+)\]$/);
  if(header){
   section=header[1].trim();
   if(section==='vars'){
    if(varsSeen)throw Error('FULL_COVERAGE_CONFIG_INVALID');
    varsSeen=true;
   }
  }
  if(line.includes('GROQ_FREE_ORG_BINDING_JSON'))throw Error('FREE_ORG_BINDING_MUST_BE_SECRET');
  if(!line.includes('ENABLE_FULL_COVERAGE'))continue;
  if(section!=='vars'||!/^ENABLE_FULL_COVERAGE[ \t]*=[ \t]*"true"$/.test(line)||enabled){
   throw Error('FULL_COVERAGE_CONFIG_INVALID');
  }
  enabled=true;
 }
 return {enabled};
}
