/** Local evidence bookkeeping, not an LLM reviewer or authority over business meaning. */
export const PYTHON_ANSWER_CONTRACT_SCRIPT = String.raw`
import re as _stela_contract_re

class _StelaAnswerContract:
    def __init__(self, required):
        allowed = {'population', 'metric', 'granularity', 'denominator', 'business_rule', 'time_range'}
        if not required or not set(required) <= allowed:
            raise ValueError('Declare relevant contract fields: ' + ', '.join(sorted(allowed)))
        self.required = list(dict.fromkeys(required))
        self.claims, self.checks = {}, {}

    def claim(self, field, value, *, source, evidence):
        if field not in self.required or not isinstance(value, str) or not value.strip():
            raise ValueError('Claim must name a required field and a nonempty meaning')
        self._evidence(source, evidence)
        claim = dict(value=value, source=source, evidence=evidence)
        if field in self.claims and self.claims[field] != claim:
            raise ValueError('Conflicting claim: create a revised contract explicitly, do not silently overwrite ' + field)
        self.claims[field] = claim
        return self

    def _evidence(self, source, evidence):
        if not all(isinstance(v, str) and v.strip() and len(v) <= 4000 for v in (source, evidence)):
            raise ValueError('Provide a source reference and bounded evidence; do not invent missing definitions')

    def check_equal(self, name, observed, expected, *, source, evidence):
        self._evidence(source, evidence)
        self.checks[name] = dict(passed=bool(observed == expected), observed=observed, expected=expected, source=source, evidence=evidence)
        return self

    def check_coverage(self, name, *, total, covered, unresolved=0, unprocessed=0, source, evidence):
        values = (total, covered, unresolved, unprocessed)
        if any(type(v) is not int or v < 0 for v in values) or covered + unresolved + unprocessed > total:
            raise ValueError('Coverage requires consistent nonnegative integer counts for the declared population')
        self._evidence(source, evidence)
        self.checks[name] = dict(passed=covered == total and unresolved == 0 and unprocessed == 0,
            total=total, covered=covered, unresolved=unresolved, unprocessed=unprocessed, source=source, evidence=evidence)
        return self

    def check_granularity(self, name, values, *, pattern, source, evidence):
        self._evidence(source, evidence)
        mismatches = [str(v) for v in values if not _stela_contract_re.fullmatch(pattern, str(v))]
        self.checks[name] = dict(passed=not mismatches, mismatches=mismatches[:20], pattern=pattern, source=source, evidence=evidence)
        return self

    def report(self):
        missing = [f for f in self.required if f not in self.claims]
        failed = [name for name, check in self.checks.items() if not check['passed']]
        return dict(claims=self.claims, checks=self.checks, unresolved=missing, failedChecks=failed,
            structurallyReady=not missing and not failed and bool(self.checks),
            caveat='Checks validate supplied observations, not business truth or completeness of an already filtered source.')

    def require_ready(self):
        report = self.report()
        if not report['structurallyReady']:
            raise ValueError('Answer contract has missing claims, failed checks or no verification: ' + str(report))
        return report

class _StelaAnalysis:
    def contract(self, *, required):
        return _StelaAnswerContract(required)
`;
