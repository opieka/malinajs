
import { assert, detectExpressionType, isSimpleName, unwrapExp } from '../utils'


export function makeComponent(node, makeEl) {
    let propList = node.attributes;
    let binds = [];
    let head = [];
    let forwardAllEvents = false;
    let injectGroupCall = 0;
    let spreading = false;

    if(node.body && node.body.length) {
        let slots = {};
        let defaultSlot = {
            name: 'default',
            type: 'slot'
        }
        defaultSlot.body = node.body.filter(n => {
            if(n.type != 'slot') return true;
            let rx = n.value.match(/^\#slot:(\S+)/);
            if(rx) n.name = rx[1];
            else n.name = 'default';
            assert(!slots[n], 'double slot');
            slots[n.name] = n;
        });

        if(!slots.default) slots.default = defaultSlot;
        // TODO: (else) check if defaultSlot is empty

        Object.values(slots).forEach(slot => {
            assert(isSimpleName(slot.name));
            let args = '', setters = '';
            let rx = slot.value && slot.value.match(/^#slot\S*\s+(.*)$/);
            if(rx) {
                let props = rx[1].trim().split(/\s*,\s*/);
                props.forEach(n => {
                    assert(isSimpleName(n), 'Wrong prop for slot');
                });
                args = `let ${props.join(', ')};`;
                setters = ',' + props.map(name => {
                    return `set_${name}: (_${name}) => {${name} = _${name}; $$apply();}`;
                }).join(',\n');
            }

            let block = this.buildBlock(slot);
            head.push(`
                slots.${slot.name} = function($label) {
                    let $childCD = $cd.new();
                    let $tpl = $$htmlToFragment(\`${this.Q(block.tpl)}\`);

                    ${args}

                    ${block.source};
                    ${block.name}($childCD, $tpl);
                    $label.parentNode.insertBefore($tpl, $label.nextSibling);

                    return {
                        destroy: () => {
                            $childCD.destroy();
                        }
                        ${setters}
                    }
                }
            `);
        });
    }

    let boundEvents = {};
    let twoBinds = [];
    propList = propList.filter(prop => {
        let name = prop.name;
        let value = prop.value;
        if(name == '@@') {
            forwardAllEvents = true;
            return false;
        } else if(name.startsWith('{...')) {
            spreading = true;
        } else if(name[0] == ':' || name.startsWith('bind:')) {
            let inner, outer;
            if(name[0] == ':') inner = name.substring(1);
            else inner = name.substring(5);
            if(value) outer = unwrapExp(value);
            else outer = inner;
            assert(isSimpleName(inner), `Wrong property: '${inner}'`);
            assert(detectExpressionType(outer) == 'identifier', 'Wrong bind name: ' + outer);
            twoBinds.push(inner);
            let valueName = 'v' + (this.uniqIndex++);
            head.push(`props.${inner} = ${outer};`);
            head.push(`boundProps.${inner} = 2;`);
            binds.push(`
                if('${inner}' in $component) {
                    let value = $$cloneDeep(props.${inner});
                    let $$_w0 = $watch($cd, () => (${outer}), (value) => {
                        props.${inner} = value;
                        $$_w1.value = $$_w0.value;
                        $component.${inner} = value;
                    }, {ro: true, cmp: $$compareDeep, value});
                    let $$_w1 = $watch($component.$cd, () => ($component.${inner}), (${valueName}) => {
                        props.${inner} = ${valueName};
                        $$_w0.value = $$_w1.value;
                        ${outer} = ${valueName};
                        $$apply();
                    }, {cmp: $$compareDeep, value});
                } else console.error("Component ${node.name} doesn't have prop ${inner}");
            `);
            return false;
        }
        return true;
    });

    if(spreading) {
        head.push('let spreadObject = $$makeSpreadObject2($cd, props);');
        head.push('boundProps.$$spreading = true;');
        binds.push('spreadObject.emit = $component.push;');
        if(twoBinds.length) {
            head.push(`spreadObject.except(['${twoBinds.join(',')}']);`);
        }
    }

    propList.forEach(prop => {
        let name = prop.name;
        let value = prop.value;
        if(name[0] == '#') {
            assert(!value, 'Wrong ref');
            let name = name.substring(1);
            assert(isSimpleName(name), name);
            this.checkRootName(name);
            binds.push(`${name} = $component;`);
            return;
        } else if(name[0] == '{') {
            value = name;
            name = unwrapExp(name);
            if(name.startsWith('...')) {
                name = name.substring(3);
                assert(detectExpressionType(name) == 'identifier', 'Wrong prop');
                head.push(`spreadObject.spread(() => ${name})`);
                return;
            };
            assert(detectExpressionType(name) == 'identifier', 'Wrong prop');
        } else if(name[0] == '@' || name.startsWith('on:')) {
            if(name[0] == '@') name = name.substring(1);
            else name = name.substring(3);
            let arg = name.split(/[\|:]/);
            let exp, handler, isFunc, event = arg.shift();
            assert(event);

            if(value) exp = unwrapExp(value);
            else {
                if(!arg.length) {
                    // forwarding
                    if(forwardAllEvents || boundEvents[event]) head.push(`$$addEvent(events, '${event}', $option.events.${event});`);
                    else head.push(`events.${event} = $option.events.${event};`);
                    boundEvents[event] = true;
                    return;
                }
                handler = arg.pop();
            }
            assert(arg.length == 0);
            assert(!handler ^ !exp);

            if(exp) {
                let type = detectExpressionType(exp);
                if(type == 'identifier') {
                    handler = exp;
                    exp = null;
                } else isFunc = type == 'function';
            }

            let callback;
            if(isFunc) {
                callback = exp;
            } else if(handler) {
                this.checkRootName(handler);
                callback = handler;
            } else {
                callback = `($event) => {${this.Q(exp)}}`;
            }

            if(forwardAllEvents || boundEvents[event]) head.push(`$$addEvent(events, '${event}', ${callback});`);
            else head.push(`events.${event} = ${callback};`);
            boundEvents[event] = true;
            return;
        }
        assert(value, 'Empty property');
        assert(isSimpleName(name), `Wrong property: '${name}'`);
        if(value.indexOf('{') >= 0) {
            let exp = this.parseText(value);
            let fname = 'pf' + (this.uniqIndex++);
            let valueName = 'v' + (this.uniqIndex++);
            if(spreading) {
                return head.push(`
                    spreadObject.prop('${name}', () => ${exp});
                `);
            }
            injectGroupCall++;
            head.push(`
                let ${fname} = () => (${exp});
                let ${valueName} = ${fname}()
                props.${name} = ${valueName};
                boundProps.${name} = 1;

                $watch($cd, ${fname}, _${name} => {
                    props.${name} = _${name};
                    groupCall();
                }, {ro: true, cmp: $$compareDeep, value: $$cloneDeep(${valueName})});
            `);
        } else {
            if(spreading) {
                head.push(`
                    spreadObject.attr('${name}', \`${this.Q(value)}\`);
                `);
            } else {
                head.push(`props.${name} = \`${this.Q(value)}\``);
            }
        }
    });

    if(forwardAllEvents) head.unshift('let events = Object.assign({}, $option.events);');
    else head.unshift('let events = {};');
    if(injectGroupCall) {
        if(injectGroupCall == 1) {
            head.push('let groupCall;');
            binds.push('groupCall = $component.push;');
        } else {
            head.push('let groupCall = $$groupCall();');
            binds.push('groupCall.emit = $component.push;');
        }
    }
    if(spreading) head.push('spreadObject.build();');

    return {
        bind:`
        {
            let props = {};
            let boundProps = {};
            let slots = {};
            ${head.join('\n')};
            let $component = ${node.name}(${makeEl()}, {afterElement: true, noMount: true, props, boundProps, events, slots});
            if($component) {
                if($component.destroy) $cd.d($component.destroy);
                ${binds.join('\n')};
                if($component.onMount) $tick($component.onMount);
            }
    }`};
};
