export const layers = ['evidence', 'domain', 'need', 'strategy', 'model', 'flow', 'surface']
export const artifact = ref => ({ ref: `fixture:${ref}`, digest: `sha256:${'b'.repeat(64)}` })
export function assessments(unsupported = null, support = 'weak', revision = 1) {
  return layers.map((layer, index) => ({ layer, revision,
    decision: `${layer}: bounded synthetic decision`,
    evidenceCriterion: `${layer}: supplied observation matches the declared decision`,
    criterionMet: layer !== unsupported,
    artifacts: [artifact(`${layer}-observation`)],
    uncertainty: layer === unsupported ? `Unresolved ${layer} claim` : 'No outstanding contradiction in supplied observations',
    dependencies: index ? [{ layer: layers[index - 1], revision }] : [],
    support: layer === unsupported ? support : 'strong',
    notApplicableReason: null,
    question: layer === unsupported ? { id: `${layer}-claim`, prompt: `Which observation resolves the ${layer} claim?` } : null
  }))
}
