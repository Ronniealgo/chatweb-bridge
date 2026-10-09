import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectComposerDOM } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/composer.js';

function fixture({form=false,buttons=1,depth=5,disabled=false,label='发送',submit=false}={}) {
  class Element {
    constructor(tag,attrs={}) {this.tagName=tag.toUpperCase();this.attrs=attrs;this.children=[];this.id='';this.disabled=false;}
    add(child){this.children.push(child);child.parentElement=this;return child;}
    getAttribute(name){return this.attrs[name]??null;}
    getBoundingClientRect(){return {width:30,height:20};}
    closest(tag){for(let p=this;p;p=p.parentElement)if(p.tagName===tag.toUpperCase())return p;return null;}
    querySelectorAll(selectors){const all=[];const walk=node=>{for(const c of node.children){all.push(c);walk(c);}};walk(this);return all.filter(el=>selectors.split(',').some(part=>{
      part=part.trim();if(!part.startsWith('button')||el.tagName!=='BUTTON')return false;
      if(part.includes('#'))return el.id===part.split('#')[1];
      const attr=part.match(/\[([^=]+)="([^"]+)"\]/);return attr?el.getAttribute(attr[1])===attr[2]:true;
    }));}
  }
  const body=new Element('body');let root=body.add(new Element(form?'form':'div')),parent=root;
  for(let i=1;i<depth;i++)parent=parent.add(new Element('div'));
  const editor=parent.add(new Element('div'));editor.isContentEditable=true;editor.textContent='owned-marker';
  let clicks=0;for(let i=0;i<buttons;i++){const b=root.add(new Element('button',{'aria-label':label,type:submit?'submit':'button'}));b.disabled=disabled;b.click=()=>clicks++;}
  const doc={body,readyState:'interactive',activeElement:editor,querySelector:selector=>selector==='editor'?editor:null};
  return {doc,editor,clicks:()=>clicks};
}
function inspect(f,action){const old=globalThis.document;globalThis.document=f.doc;try{return inspectComposerDOM({editors:['editor'],selector:action?'editor':undefined,send:'button[aria-label="发送"], button[aria-label="Send"]',marker:'owned-marker',action});}finally{globalThis.document=old;}}
test('the actual DOM resolver finds a labelled send button without a form',()=>{
  const f=fixture();const state=inspect(f);assert.equal(state.hasForm,false);assert.equal(state.sendReady,true);assert.equal(state.ready,true);
  assert.equal(inspect(f,'submit'),true);assert.equal(f.clicks(),1);
});
test('form submit buttons remain supported even without a send label',()=>{
  const f=fixture({form:true,label:'',submit:true});assert.equal(inspect(f).sendReady,true);assert.equal(inspect(f,'submit'),true);
});
test('ambiguous or unlabelled nearby buttons are never clicked',()=>{
  for(const options of [{buttons:2},{form:true,buttons:2,submit:true},{label:'Delete'},{disabled:true},{depth:8}]){
    const f=fixture(options);assert.equal(inspect(f).sendReady,false);assert.equal(inspect(f,'submit'),false);assert.equal(f.clicks(),0);
  }
});
test('a changed draft immediately before a DOM click is preserved',()=>{
  const f=fixture();f.editor.textContent='private user draft';assert.equal(inspect(f,'submit'),false);assert.equal(f.clicks(),0);assert.equal(f.editor.textContent,'private user draft');
});

test('a visible login control is an explicit gate; a hidden control or missing composer is not login proof',()=>{
  for(const visible of [true,false]){
    const f=fixture();const query=f.doc.querySelector;
    f.doc.querySelector=selector=>selector.includes('login-button') ? {getBoundingClientRect:()=>({width:visible?30:0,height:20})} : query(selector);
    assert.equal(inspect(f).loginRequired,visible);
    assert.equal(inspect(f,'submit'),!visible);
  }
  const f=fixture();f.doc.querySelector=()=>null;
  const state=inspect(f);assert.equal(state.ready,false);assert.equal(state.loginRequired,false);assert.equal(state.gate,false);
});
