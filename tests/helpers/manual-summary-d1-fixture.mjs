// The operational contract owns the closed synthetic binding factory and its
// private database association. Tests cannot register an arbitrary transport.
export {createOfflineD1FixtureBinding as createSyntheticD1Binding} from '../../scripts/manual-summary-operational-contract.mjs';
