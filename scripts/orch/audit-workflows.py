#!/usr/bin/env python3
"""Offline workflow-property audit. Configuration evidence cannot establish performance."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

import yaml
from yaml.nodes import MappingNode, ScalarNode, SequenceNode


class BoundedLoader(yaml.SafeLoader):
    """Enforce parse budgets before PyYAML recursively constructs a node graph."""
    def __init__(self, stream):
        super().__init__(stream)
        self.node_depth = 0
        self.nodes_remaining = 10000

    def compose_node(self, parent, index):
        self.node_depth += 1
        self.nodes_remaining -= 1
        try:
            if self.node_depth > 64 or self.nodes_remaining < 0:
                raise ValueError('YAML parse budget exceeded')
            return super().compose_node(parent, index)
        finally:
            self.node_depth -= 1


def mapping(node):
    if not isinstance(node, MappingNode):
        raise ValueError('expected mapping')
    result = {}
    for key, value in node.value:
        if not isinstance(key, ScalarNode) or key.value in result:
            raise ValueError('duplicate or complex YAML key')
        result[key.value] = value
    return result


def scalar(node):
    return node.value if isinstance(node, ScalarNode) else None


def expression(node):
    value = scalar(node)
    if value is None:
        return None
    value = value.strip()
    if value.startswith('${{') and value.endswith('}}'):
        value = value[3:-2].strip()
    return value


def scalar_list(node):
    return isinstance(node, SequenceNode) and bool(node.value) and all(isinstance(n, ScalarNode) for n in node.value)


def text_scalar(node):
    return isinstance(node, ScalarNode) and node.tag == 'tag:yaml.org,2002:str' and bool(node.value.strip())


def workflow_shape(node):
    """Validate the nodes consumed by property checks before emitting any pass."""
    workflow = mapping(node)
    jobs = mapping(workflow['jobs'])
    if not jobs:
        raise ValueError('workflow needs jobs')
    on = workflow.get('on')
    if isinstance(on, MappingNode):
        triggers = mapping(on)
        for name, trigger in triggers.items():
            if isinstance(trigger, ScalarNode) and trigger.tag == 'tag:yaml.org,2002:null':
                continue
            if name == 'schedule':
                if not isinstance(trigger, SequenceNode) or not trigger.value:
                    raise ValueError('invalid schedule')
                for entry in trigger.value:
                    if not isinstance(mapping(entry).get('cron'), ScalarNode):
                        raise ValueError('invalid cron')
                continue
            filters = mapping(trigger)
            for key in ('types', 'paths', 'paths-ignore', 'branches', 'branches-ignore', 'tags', 'tags-ignore', 'workflows'):
                if key in filters and not scalar_list(filters[key]):
                    raise ValueError('invalid trigger filter')
    elif scalar_list(on):
        triggers = {n.value: None for n in on.value}
    elif isinstance(on, ScalarNode) and on.tag == 'tag:yaml.org,2002:str' and on.value:
        triggers = {on.value: None}
    else:
        raise ValueError('invalid workflow trigger')
    if not triggers:
        raise ValueError('missing workflow trigger')
    for job_node in jobs.values():
        job = mapping(job_node)
        for key in ('if', 'uses', 'timeout-minutes'):
            if key in job and not isinstance(job[key], ScalarNode):
                raise ValueError('invalid scalar job field')
        if 'needs' in job and not (isinstance(job['needs'], ScalarNode) or scalar_list(job['needs'])):
            raise ValueError('invalid job dependencies')
        if 'uses' in job:
            if not text_scalar(job['uses']) or 'steps' in job or 'runs-on' in job:
                raise ValueError('reusable job has execution fields')
            continue
        runner = job.get('runs-on')
        runner_group = mapping(runner) if isinstance(runner, MappingNode) else {}
        if not (text_scalar(runner) or scalar_list(runner) and all(text_scalar(n) for n in runner.value) or
                runner_group and set(runner_group) <= {'group', 'labels'} and all(
                    text_scalar(v) or scalar_list(v) and all(text_scalar(n) for n in v.value) for v in runner_group.values())):
            raise ValueError('missing or invalid runner')
        steps = job.get('steps')
        if not isinstance(steps, SequenceNode) or not steps.value:
            raise ValueError('normal job needs steps')
        for step_node in steps.value:
            step = mapping(step_node)
            if ('run' in step) == ('uses' in step):
                raise ValueError('step needs exactly one execution form')
            for key in ('run', 'uses'):
                if key in step and not text_scalar(step[key]):
                    raise ValueError('invalid scalar step field')
            if 'if' in step and not isinstance(step['if'], ScalarNode):
                raise ValueError('invalid step condition')
    return workflow, jobs, triggers


def valid_graph(node, ancestors=(), depth=0, budget=None):
    budget = [10000] if budget is None else budget
    budget[0] -= 1
    if budget[0] < 0 or depth > 64 or id(node) in ancestors:
        raise ValueError('recursive YAML')
    if isinstance(node, MappingNode):
        mapping(node)
        for key, child in node.value:
            if key.value == '<<':
                raise ValueError('YAML merge keys require effective-config review')
            valid_graph(child, (*ancestors, id(node)), depth + 1, budget)
    elif isinstance(node, SequenceNode):
        for child in node.value:
            valid_graph(child, (*ancestors, id(node)), depth + 1, budget)
    elif not isinstance(node, ScalarNode):
        raise ValueError('unsupported YAML')


def response(property_name, location, owner):
    repairs = {
        'syntax': 'Repair workflow YAML and replay the workflow parser',
        'job-timeout': 'Set a measured positive job timeout and preserve child cleanup',
        'action-pin': 'Pin the reviewed action to an immutable commit or image digest',
        'privileged-checkout': 'Keep untrusted PR code out of privileged execution; use the unprivileged PR lane',
        'required-trigger': 'Report the required verdict for every candidate; select inside the workflow',
        'required-unconditional': 'Always run the required gate and fail on missing upstream verdicts',
        'permissions': 'Declare least-privilege workflow/job permissions and review any writes',
    }
    key = hashlib.sha256(f'{location}:{property_name}'.encode()).hexdigest()[:20]
    return {'id': f'workflow-{key}', 'owner': owner, 'remediation': repairs[property_name],
            'test': f'Replay a violation of {property_name} and a clean control at {location}',
            'clear': f'A complete audit of the same workflow/job proves {property_name} with no breach'}


def audit(root, required=(), owner='orchestrator-maintainer'):
    root = Path(root)
    if not isinstance(owner, str) or not owner.strip():
        raise ValueError('owner required')
    properties = []
    def record(file, job, name, status, node, evidence):
        item = {'file': file, 'job': job, 'property': name, 'status': status,
                'line': node.start_mark.line + 1 if node else 1, 'evidence': evidence}
        if status == 'breach':
            item['response'] = response(name, f'{file}:{job}', owner)
        properties.append(item)

    targets = {}
    for item in required:
        file, job = item['workflow'], item['job']
        if not isinstance(file, str) or not re.fullmatch(r'\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml', file) or not isinstance(job, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', job):
            raise ValueError('invalid required-context manifest')
        targets.setdefault(file, set()).add(job)
    paths = sorted(set(root.glob('.github/workflows/*.yml')) | set(root.glob('.github/workflows/*.yaml')) |
                   {root / name for name in targets})
    for path in paths:
        file = path.relative_to(root).as_posix()
        try:
            # Do not follow workflow symlinks outside the reviewed checkout.
            if path.is_symlink() or root.resolve() not in path.resolve().parents:
                raise ValueError('workflow outside checkout')
            text = path.read_text()
            if len(text) > 1024 * 1024:
                raise ValueError('workflow too large')
            node = yaml.compose(text, Loader=BoundedLoader)
            valid_graph(node)
            workflow, jobs, triggers = workflow_shape(node)
            on = workflow.get('on')
        except (OSError, ValueError, KeyError, yaml.YAMLError, RecursionError):
            record(file, '*', 'syntax', 'unknown', None, 'Workflow missing, unreadable, ambiguous or invalid; raw parser diagnostics withheld')
            continue
        record(file, '*', 'syntax', 'pass', node, 'Parsed YAML with unique keys and bounded nonrecursive structure')
        permissions = workflow.get('permissions')
        trusted = 'pull_request_target' in triggers or 'workflow_run' in triggers
        for missing in sorted(targets.get(file, set()) - set(jobs)):
            record(file, missing, 'required-trigger', 'breach', workflow['jobs'], 'Required job absent from workflow')
        for job_name, job_node in jobs.items():
            job = mapping(job_node)
            timeout = scalar(job.get('timeout-minutes'))
            if 'uses' in job:
                record(file, job_name, 'job-timeout', 'unknown', job_node, 'Reusable workflow: inspect the pinned called workflow for effective timeouts')
            else:
                valid_timeout = bool(timeout and re.fullmatch(r'[0-9]+', timeout) and 0 < int(timeout) <= 360)
                record(file, job_name, 'job-timeout', 'pass' if valid_timeout else 'breach', job.get('timeout-minutes', job_node),
                       'Positive bounded job timeout' if valid_timeout else 'Job lacks a static positive bounded timeout')
            effective_permissions = job.get('permissions', permissions)
            if isinstance(effective_permissions, MappingNode):
                permissions_map = mapping(effective_permissions)
                status = 'pass' if all(scalar(v) in ('read', 'none') for v in permissions_map.values()) else 'unknown'
            else:
                status = 'pass' if scalar(effective_permissions) == 'read-all' else 'breach'
            record(file, job_name, 'permissions', status, effective_permissions or job_node,
                   'Read-only explicit permissions' if status == 'pass' else 'Missing permissions or write permissions need trust review')
            if job_name in targets.get(file, set()):
                condition = expression(job.get('if'))
                always = condition == 'always()'
                unconditional = always or ('needs' not in job and condition in (None, 'true'))
                record(file, job_name, 'required-unconditional', 'pass' if unconditional else 'breach',
                       job.get('if', job_node), 'Required gate must report even after upstream failure; any conditional selection needs an always-reporting gate')
                trigger = triggers.get('pull_request')
                filters = mapping(trigger) if isinstance(trigger, MappingNode) else {}
                types = filters.get('types')
                candidate_types = {scalar(n) for n in types.value} if isinstance(types, SequenceNode) else set()
                skipped = 'pull_request' not in triggers or any(k in filters for k in ('paths', 'paths-ignore', 'branches', 'branches-ignore')) or ('types' in filters and not {'opened', 'reopened', 'synchronize'} <= candidate_types)
                record(file, job_name, 'required-trigger', 'breach' if skipped else 'pass', trigger or on,
                       'Required candidate workflow has no event/path filter' if not skipped else 'Required workflow can be omitted by its trigger/filter')
            steps_node = job.get('steps')
            steps = steps_node.value if isinstance(steps_node, SequenceNode) else []
            pin_nodes = [job['uses']] if 'uses' in job else []
            found_untrusted = False
            for step_node in steps:
                step = mapping(step_node)
                if 'uses' in step:
                    pin_nodes.append(step['uses'])
                uses = scalar(step.get('uses')) or ''
                if trusted and uses.startswith('actions/checkout@'):
                    inputs = mapping(step['with']) if isinstance(step.get('with'), MappingNode) else {}
                    selected = [scalar(inputs.get(k)) or '' for k in ('ref', 'repository')]
                    if any('${{' in value for value in selected):
                        record(file, job_name, 'privileged-checkout', 'breach', step_node,
                               'Privileged workflow checks out an expression-selected source; isolate untrusted execution')
                        found_untrusted = True
                if trusted and 'run' in step and 'github.event.pull_request' in (scalar(step['run']) or ''):
                    record(file, job_name, 'privileged-checkout', 'breach', step['run'],
                           'Privileged shell consumes pull-request input')
                    found_untrusted = True
            if not found_untrusted:
                record(file, job_name, 'privileged-checkout', 'unknown' if trusted else 'not-applicable', job_node,
                       'Privileged event: dependency/scripts trust needs independent judgment' if trusted else 'No pull_request_target or workflow_run privileged trigger')
            for uses_node in pin_nodes:
                uses = scalar(uses_node) or ''
                pinned = bool(re.fullmatch(r'[^\s@]+@[0-9a-f]{40}', uses) or
                              re.fullmatch(r'docker://[^\s@]+@sha256:[0-9a-f]{64}', uses) or uses.startswith('./'))
                record(file, job_name, 'action-pin', 'pass' if pinned else 'breach', uses_node,
                       'Immutable external source or reviewed local action' if pinned else 'External action lacks a full immutable revision')
    if not paths:
        record('.github/workflows', '*', 'syntax', 'unknown', None, 'No workflows observed')
    if not required:
        record('.github/workflows', '*', 'required-trigger', 'unknown', None, 'Live required-context contract not supplied; no required-gate claim')
    # Same job/property is a single regression even if several steps violate it.
    responses = {p['response']['id']: p['response'] for p in properties if 'response' in p}
    status = 'breach' if responses else 'unknown' if any(p['status'] == 'unknown' for p in properties) else 'pass'
    return {'schema': 'workflow-audit/v1', 'status': status, 'properties': properties, 'responses': list(responses.values()),
            'judgment_required': ['dependency completeness', 'readiness and exact-source evidence', 'credential and artifact trust'],
            'performance': {'status': 'unknown', 'reason': 'Compare measured end-to-end work and verified delivery; configuration proves no speedup'}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', help='Read-only checkout to inspect')
    parser.add_argument('--required', help='JSON array binding required workflow/job names, from current REST contract')
    parser.add_argument('--owner', default='orchestrator-maintainer')
    args = parser.parse_args()
    try:
        required = json.loads(Path(args.required).read_text()) if args.required else []
        report = audit(args.root, required, args.owner)
        print(json.dumps(report, sort_keys=True))
        return 1 if report['status'] == 'breach' else 2 if report['status'] == 'unknown' else 0
    except (OSError, ValueError, TypeError, KeyError, RecursionError, OverflowError):
        print(json.dumps({'schema': 'workflow-audit/v1', 'status': 'unknown', 'error': 'invalid or unreadable audit inputs'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
