// Read-only Workers Builds diagnostic. Never print environment values.
import {safeBuildEnvironmentReport} from './deployment-runtime.mjs';

console.log(JSON.stringify(safeBuildEnvironmentReport(process.env)));
