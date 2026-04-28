// Git commit event helpers used by Chronicle subsystems.
// Extracted from the former ChronicleManifests module so the visual
// "manifest" rendering could be removed without losing event collection.

export {
    collectCommitEvents,
    commitMessageFromCommand,
} from '../shared/GitEventIdentity.js';
