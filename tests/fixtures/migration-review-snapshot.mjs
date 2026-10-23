import {databaseId,migrationName,expectedTriggerSql} from '../../scripts/full-coverage-migration-preflight.mjs';
import {reviewedMigrationSource} from '../../scripts/migration-source-catalog.mjs';
export function migrationBefore(){
 const repositorySource=reviewedMigrationSource(),index=repositorySource.files.findIndex(file=>file.name===migrationName);
 return {kind:'FULL_COVERAGE_MIGRATION_READONLY_V2',databaseId,capturedAt:new Date().toISOString(),repositorySource,
  pendingMigrations:repositorySource.files.slice(index).map(file=>file.name),appliedMigrations:repositorySource.files.slice(0,index).map(file=>file.name),
  managedTriggerNames:[],presentTables:['jobs','yta_sources','yta_operations','usage_events'],unsettledRelevantOperationCount:0,
  runningOrQueuedBuildCount:0,productionBuildsDisabled:true,fullCoverageDispatchDisabled:true,synthesisDispatchDisabled:true,
  timeTravel:{capturedAt:new Date().toISOString(),bookmark:'LOCAL_FIXTURE_ONLY'},
  executionScope:{kind:'SINGLE_MIGRATION_DIRECTORY_V1',databaseId,migrationsTable:'d1_migrations',files:[{name:migrationName,sha256:repositorySource.files[index].sha256}],pendingMigrations:[migrationName]}};
}
export function migrationAfter(before){return {databaseId,capturedAt:new Date().toISOString(),repositorySource:structuredClone(before.repositorySource),
 pendingMigrations:before.pendingMigrations.slice(1),appliedMigrations:[...before.appliedMigrations,migrationName],
 executionScope:{...structuredClone(before.executionScope),pendingMigrations:[]},triggers:Object.entries(expectedTriggerSql).map(([name,sql])=>({name,sql}))};}
