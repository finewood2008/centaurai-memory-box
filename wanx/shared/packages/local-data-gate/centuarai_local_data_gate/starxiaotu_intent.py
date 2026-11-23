"""Finite, versioned assistant protocol; no model-selected authority or URLs."""
import json
import re
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name('starxiaotu_catalog.json').read_text(encoding='utf-8'))
READ_INTENTS = {'guide', 'navigate', 'query', 'search'}


def _page(value):
    return isinstance(value, str) and value in {*CATALOG['pages'], 'onboarding', 'general'}


def _object(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        raise ValueError('Invalid assistant fields')


def _text(value, maximum):
    if (not isinstance(value, str) or not value.strip() or len(value) > maximum
            or any(0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise ValueError('Invalid assistant text')


def validate_request(body):
    _object(body, ('operation_id', 'version', 'text', 'page', 'context', 'history', 'ontology_conversation'))
    if not isinstance(body['operation_id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', body['operation_id']):
        raise ValueError('Invalid assistant operation')
    if type(body['version']) is not int or body['version'] != CATALOG['version']:
        raise ValueError('Unsupported assistant protocol')
    _text(body['text'], 2000)
    if not _page(body['page']):
        raise ValueError('Invalid assistant page')
    context = body['context']
    _object(context, ('focus', 'material_title'))
    title = context['material_title']
    if not isinstance(title, str) or len(title) > 240 or any(0xD800 <= ord(c) <= 0xDFFF for c in title):
        raise ValueError('Invalid material context')
    if context['focus'] not in ['page', 'material'] or (context['focus'] == 'material') != bool(title.strip()):
        raise ValueError('Invalid assistant focus')
    if type(body['ontology_conversation']) is not bool:
        raise ValueError('Invalid assistant context')
    if type(body['history']) is not list or len(body['history']) > 4:
        raise ValueError('Invalid assistant history')
    for item in body['history']:
        _object(item, ('text', 'page', 'decision'))
        _text(item['text'], 500)
        if not _page(item['page']):
            raise ValueError('Invalid history page')
        validate_decision(item['decision'])
        if item['decision']['intent'] in {'clarify', 'unsupported'}:
            raise ValueError('History must contain resolved actions')
    return body


def validate_decision(value):
    _object(value, ('intent', 'target', 'arguments'))
    intent, target, args = value['intent'], value['target'], value['arguments']
    if not isinstance(intent, str) or not isinstance(target, str):
        raise ValueError('Invalid assistant enum')
    if intent == 'guide' and target in CATALOG['guides']:
        _object(args, ())
    elif intent == 'navigate' and target in CATALOG['pages']:
        _object(args, ())
    elif intent == 'navigate' and target == 'record' or intent == 'search' and target == 'materials':
        _object(args, ('query', 'scope') if intent == 'search' and isinstance(args, dict) and 'scope' in args else ('query',))
        _text(args['query'], 500)
        if 'scope' in args and args['scope'] not in ['project', 'active_material']:
            raise ValueError('Invalid retrieval scope')
    elif intent == 'query' and target == 'project_stats':
        _object(args, ('metric',))
        if args['metric'] not in CATALOG['metrics']:
            raise ValueError('Invalid assistant metric')
    elif intent == 'query' and target == 'ontology_rules' or intent == 'ontology_change' and target == 'ontology':
        _object(args, ())
    elif intent == 'clarify' and target == 'none':
        _object(args, ('reason', 'candidates'))
        if args['reason'] not in ['ambiguous', 'multiple', 'missing_context']:
            raise ValueError('Invalid clarification')
        candidates = args['candidates']
        if type(candidates) is not list or len(candidates) not in (0, 2) or not candidates and args['reason'] != 'missing_context':
            raise ValueError('Invalid clarification candidates')
        for candidate in candidates:
            _object(candidate, ('intent', 'target', 'arguments'))
            if not isinstance(candidate['intent'], str) or candidate['intent'] not in READ_INTENTS:
                raise ValueError('Clarification cannot introduce a mutation or another clarification')
            validate_decision(candidate)
        if len(candidates) == 2 and json.dumps(candidates[0], sort_keys=True) == json.dumps(candidates[1], sort_keys=True):
            raise ValueError('Duplicate clarification candidates')
    elif intent == 'unsupported' and target == 'none':
        _object(args, ())
    else:
        raise ValueError('Unsupported assistant action')
    return value


def validate_resolution(value, body):
    validate_decision(value)
    actions = value['arguments']['candidates'] if value['intent'] == 'clarify' else [value]
    for action in actions:
        if action['intent'] == 'search' and action['arguments'].get('scope') == 'active_material' and body['context']['focus'] != 'material':
            raise ValueError('The current material is not available')
    return value


def decision_schema():
    def obj(properties):
        return {'type':'object', 'properties':properties, 'required':list(properties), 'additionalProperties':False}
    def enum(values):
        return {'type':'string', 'enum':list(values)}
    query = {'query':{'type':'string', 'minLength':1, 'maxLength':500}}
    # Keep an object root for providers' structured-output dialects. The exact
    # intent/target/argument pairing is checked independently after generation.
    targets=sorted({*CATALOG['guides'],*CATALOG['pages'],'record','project_stats','ontology_rules','materials','none'})
    read_args = [obj({}), obj(query), obj({**query, 'scope':enum(['project','active_material'])}), obj({'metric':enum(CATALOG['metrics'])})]
    candidate = obj({'intent':enum(sorted(READ_INTENTS)), 'target':enum([t for t in targets if t != 'none']),
                     'arguments':{'anyOf':read_args}})
    clarification = obj({'reason':enum(['ambiguous','multiple','missing_context']),
                         'candidates':{'type':'array','items':candidate,'maxItems':2}})
    return obj({'intent':enum(CATALOG['intents']), 'target':enum(targets),
                'arguments':{'anyOf':[*read_args, clarification]}})
