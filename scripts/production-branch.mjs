export function assertProductionBranch(env,branch,head){
  if(env.WORKERS_CI){
    if(env.WORKERS_CI_BRANCH!=='main'||env.WORKERS_CI_COMMIT_SHA!==head){
      throw Error('Production deploy requires Workers Builds main branch and matching commit SHA.');
    }
  }else if(branch!=='main'){
    throw Error('Production deploy requires the main branch; review branches cannot deploy.');
  }
  return true;
}
