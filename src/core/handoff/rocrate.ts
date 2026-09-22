/**
 * RO-Crate metadata for handoff bundles.
 *
 * RO-Crate answers: what is in this package, who produced it, and how do the
 * parts relate? It is plain JSON-LD, so a consumer gets those relationships
 * without reading our docs — and a generic RO-Crate viewer can render the
 * bundle without knowing what SandBase is.
 *
 * The root data entity is `./` per the RO-Crate spec; every other entity
 * carries an `@id` that the root's `hasPart` points at. Only entities that
 * actually exist in the bundle are emitted, because a metadata graph that
 * describes absent files is worse than none.
 */

export const RO_CRATE_CONTEXT = 'https://w3id.org/ro/crate/1.1/context';
export const RO_CRATE_CONFORMS_TO = { '@id': 'https://w3id.org/ro/crate/1.1' };
export const RO_CRATE_PROFILE = 'https://w3id.org/ro/crate/1.1';

export type RoCratePart = {
  /** Bundle-relative path, e.g. `data/transcript.json`. */
  path: string;
  name: string;
  description: string;
  /** Schema.org type for the entity, e.g. `File`, `Dataset`. */
  entityType?: string;
  encodingFormat?: string;
  sha512?: string;
  bytes?: number;
};

export type RoCrateInput = {
  /** Stable identifier for this crate, normally the bundle id. */
  bundleId: string;
  name: string;
  description: string;
  createdAt: string;
  /** Human- or system-readable producer, e.g. `managed-agents/0.3.8`. */
  generator: string;
  /** Entities describing the session, agent, transcript, and so on. */
  parts: RoCratePart[];
  /** Entities that are not files: session, agent, environment. */
  contextEntities?: Array<Record<string, unknown>>;
};

/**
 * Build the `ro-crate-metadata.json` document.
 *
 * `conformsTo` is what makes it a crate rather than arbitrary JSON-LD, so it is
 * always present. `datePublished` and `sdPublisher` are set from the actual
 * bundle time and runtime version rather than left to a consumer to guess.
 */
export function buildRoCrateMetadata(input: RoCrateInput): Record<string, unknown> {
  const fileEntities = input.parts.map((part) => ({
    '@id': part.path,
    '@type': part.entityType ?? 'File',
    name: part.name,
    description: part.description,
    ...(part.encodingFormat ? { encodingFormat: part.encodingFormat } : {}),
    ...(part.sha512 ? { 'sha512': part.sha512 } : {}),
    ...(typeof part.bytes === 'number' ? { contentSize: `${part.bytes} B` } : {}),
  }));

  const hasPart = [
    ...fileEntities.map((entity) => ({ '@id': entity['@id'] })),
    ...(input.contextEntities ?? []).map((entity) => ({ '@id': entity['@id'] as string })),
  ];

  return {
    '@context': RO_CRATE_CONTEXT,
    '@graph': [
      {
        '@id': 'ro-crate-metadata.json',
        '@type': 'CreativeWork',
        conformsTo: RO_CRATE_CONFORMS_TO,
        about: { '@id': './' },
      },
      {
        '@id': './',
        '@type': 'Dataset',
        name: input.name,
        description: input.description,
        datePublished: input.createdAt,
        // An entity reference, per RO-Crate 1.1 — a bare string here would not
        // resolve as a conformsTo relationship for generic crate readers.
        conformsTo: { '@id': RO_CRATE_PROFILE },
        identifier: input.bundleId,
        hasPart,
        creator: { '@id': '#generator' },
      },
      {
        '@id': '#generator',
        '@type': 'SoftwareApplication',
        name: input.generator,
        // The crate asserts a generator, not a human author. Claiming an author
        // would be a provenance claim the runtime cannot back.
        description: 'SandBase Harness local runtime',
      },
      ...fileEntities,
      ...(input.contextEntities ?? []),
    ],
  };
}

/** A non-file entity: a session, agent, or environment the bundle describes. */
export function crateContextEntity(
  id: string,
  type: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { '@id': id, '@type': type, name, ...extra };
}
