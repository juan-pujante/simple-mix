// Source-key catalogs keep document values separate from display language.
'use strict';
const I18n=(()=>{
  let language='es';try{language=localStorage.getItem('simplemix.language')||(navigator.language.startsWith('es')?'es':'en');}catch{}
  let catalog={},patterns=[],observer;const sources=new WeakMap(),attributes=new WeakMap();
  const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  function t(text){if(language==='es'||typeof text!=='string')return text;if(catalog[text])return catalog[text];
    for(const [regex,replacement]of patterns){const match=text.match(regex);if(match)return replacement.replace(/\{(\d+)\}/g,(_,i)=>match[Number(i)+1]);}
    return text;
  }
  function textNode(node){const parent=node.parentElement;if(!parent||parent.closest('[translate=no],script,style,#projectName,.track-name,.clip-label,.rail-info strong,#masterReportFile,#markerList input'))return;
    let source=sources.get(node);if(!source||node.data!==source.last)source={original:node.data,last:node.data};const value=source.original.replace(/^(\s*)([\s\S]*?)(\s*)$/,(_,a,b,c)=>a+t(b)+c);if(node.data!==value)node.data=value;source.last=value;sources.set(node,source);
  }
  function render(root=document.body){if(!root)return;observer?.disconnect();
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);while(walker.nextNode())textNode(walker.currentNode);
    const nodes=root.querySelectorAll?.('[title],[aria-label],[placeholder]')||[];for(const node of nodes){if(node.closest('[translate=no]'))continue;let record=attributes.get(node)||{};for(const attr of ['title','aria-label','placeholder'])if(node.hasAttribute(attr)){const value=node.getAttribute(attr);let entry=record[attr];if(!entry||value!==entry.last)entry={original:value};const next=t(entry.original);if(value!==next)node.setAttribute(attr,next);entry.last=next;record[attr]=entry;}attributes.set(node,record);}
    window.customSelectRefresh?.();
    document.documentElement.lang=language;document.documentElement.style.setProperty('--modified-label',JSON.stringify(language==='en'?' · modified':' · modificado'));
    observer?.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','placeholder']});
  }
  function setLocale(value){language=value==='en'?'en':'es';try{localStorage.setItem('simplemix.language',language);}catch{}render();}
  const ready=fetch('../shared/locales/en.json').then(r=>r.json()).then(data=>{catalog=data.messages;patterns=data.patterns.map(([source,target])=>{const parts=source.split(/\{\d+\}/);return [new RegExp('^'+parts.map(esc).join('(.+?)')+'$'),target];});render();});
  let queued=false;observer=new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;render();});});
  ready.then(()=>render());return {t,render,setLocale,locale:()=>language,ready};
})();
