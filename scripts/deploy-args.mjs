export function productionDeployArgs(env,head){
  const args=['deploy','--config','wrangler.toml','--name','holy-rice-b914','--keep-vars'];
  const approved=env.APPROVED_CONFIG_RECONCILIATION_SHA;
  if(approved!==undefined){
    if(!env.WORKERS_CI||!/^[a-f0-9]{40}$/.test(approved)||approved!==head){
      throw Error('Config reconciliation requires a Workers Builds deployment at the exact approved commit SHA.');
    }
    return args;
  }
  return [...args,'--strict'];
}
