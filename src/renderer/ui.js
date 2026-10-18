'use strict';
// A single 20 px stroke system for every control; no font glyphs or emoji.
const UI_ICONS = {
  undo:'<path d="M7 4 3 8l4 4M3 8h8a5 5 0 0 1 0 10"/>',
  redo:'<path d="m13 4 4 4-4 4m4-4H9a5 5 0 0 0 0 10"/>',
  settings:'<path d="M4 5h12M4 10h12M4 15h12"/><circle cx="7" cy="5" r="2" fill="currentColor"/><circle cx="13" cy="10" r="2" fill="currentColor"/><circle cx="8" cy="15" r="2" fill="currentColor"/>',
  play:'<path d="m7 4 9 6-9 6Z" fill="currentColor" stroke="none"/>',
  pause:'<path d="M6 4v12M14 4v12" stroke-width="3"/>',
  stop:'<rect x="5" y="5" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>',
  plus:'<path d="M10 4v12M4 10h12"/>',minus:'<path d="M4 10h12"/>',
  left:'<path d="m12 5-5 5 5 5"/>',right:'<path d="m8 5 5 5-5 5"/>',
  close:'<path d="m5 5 10 10M15 5 5 15"/>',
  folder:'<path d="M3 6V4h5l2 2h7v10H3Z"/>',
  save:'<path d="M4 3h10l3 3v11H3V3Z"/><path d="M7 3v5h6V3M6 17v-6h8v6"/>',
  export:'<path d="M10 12V3m-4 4 4-4 4 4M4 12v5h12v-5"/>',
  import:'<path d="M10 3v10m-4-4 4 4 4-4M4 14v3h12v-3"/>',
  pan:'<path d="M3 10h14M6 7l-3 3 3 3m8-6 3 3-3 3"/>',
  link:'<path d="m8 7 2-2a3.5 3.5 0 0 1 5 5l-2 2M12 13l-2 2a3.5 3.5 0 0 1-5-5l2-2M7 13l6-6"/>',
  volumeOff:'<path d="M3 8h3l4-4v12l-4-4H3ZM14 7l4 6m0-6-4 6"/>',
  volume:'<path d="M3 8h3l4-4v12l-4-4H3ZM13 7a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12"/>',
};
function uiIcon(name) { return `<svg class="ui-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICONS[name] || ''}</svg>`; }
function decorateIcons(root = document) {
  if(root.matches?.('dialog')){const title=root.querySelector('h2');if(title){title.id=root.id+'Title';root.setAttribute('aria-labelledby',title.id);}}
  root.querySelectorAll('[data-icon]').forEach(el => { if (el.querySelector('svg')) return; el.insertAdjacentHTML('afterbegin', uiIcon(el.dataset.icon)); });
}
function playbackButton(button, playing, individual = false) {
  const label = playing ? 'Pausar' : individual ? 'Escuchar' : 'Reproducir sesión';
  button.innerHTML = uiIcon(playing ? 'pause' : 'play') + (individual ? `<span>${label}</span>` : '');
  button.setAttribute('aria-label', label + (individual ? ' pista seleccionada' : ''));
  button.setAttribute('aria-pressed', String(playing));
  button.title = label + (individual ? ' pista seleccionada' : ' (Espacio)');
  if (!individual) document.querySelector('#playbackState').textContent = playing ? 'Reproduciendo' : 'Posición / duración';
}
function paintRange(input) {
  const from=Number(input.min)||0, to=Number(input.max)||100;
  input.style.setProperty('--range-fill',`${(Number(input.value)-from)/(to-from)*100}%`);
  if(input.id==='master')document.querySelector('#masterValue').textContent=Math.round(Number(input.value)*100)+'%';
}
function refreshRanges(root=document) { root.querySelectorAll('input[type="range"]').forEach(paintRange); }
document.addEventListener('input',event=>{if(event.target.matches('input[type="range"]'))paintRange(event.target);});
decorateIcons();refreshRanges();

// Custom listboxes share the visual system and keep a hidden select as model adapter.
const customSelects=new Map();let activeSelect=null,selectSequence=0;
function closeCustomSelect(){if(!activeSelect)return;const {button,popup}=activeSelect;button.setAttribute('aria-expanded','false');button.removeAttribute('aria-activedescendant');button.removeAttribute('aria-controls');if(popup.matches(':popover-open'))popup.hidePopover();popup.remove();activeSelect=null;}
function refreshCustomSelects(){
  for(const [select,entry]of customSelects)if(!select.isConnected){customSelects.delete(select);if(activeSelect?.select===select)closeCustomSelect();}
  document.querySelectorAll('select:not([data-segmented])').forEach(select=>{
    if(customSelects.has(select))return;const wrapper=document.createElement('span');wrapper.className='custom-select';const button=document.createElement('button');button.type='button';button.className='select-trigger';button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
    const text=document.createElement('span'),icon=document.createElement('span');icon.className='select-chevron';icon.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';button.append(text,icon);
    select.before(wrapper);wrapper.append(select,button);select.hidden=true;select.tabIndex=-1;select.setAttribute('aria-hidden','true');customSelects.set(select,{button,text,wrapper});
    button.onclick=()=>activeSelect?.select===select?closeCustomSelect():openCustomSelect(select);
    button.onkeydown=event=>{
      if(event.key==='Escape'&&!activeSelect)return;
      if(event.key==='Tab'){closeCustomSelect();return;}
      if(['ArrowDown','ArrowUp','Home','End','Enter',' ','Escape'].includes(event.key)){
        event.preventDefault();event.stopPropagation();if(event.key==='Escape'){closeCustomSelect();return;}
        if(!activeSelect||activeSelect.select!==select){openCustomSelect(select);if(activeSelect&&['Home','End'].includes(event.key)){activeSelect.index=event.key==='Home'?0:activeSelect.options.length-1;activeSelect.highlight();}return;}
        const a=activeSelect;if(event.key==='Enter'||event.key===' '){a.choose(a.index);return;}
        a.index=event.key==='Home'?0:event.key==='End'?a.options.length-1:Math.max(0,Math.min(a.options.length-1,a.index+(event.key==='ArrowDown'?1:-1)));a.highlight();
      }else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey){if(!activeSelect||activeSelect.select!==select)openCustomSelect(select);const a=activeSelect;if(!a)return;const next=a.options.findIndex(o=>o.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase()));if(next>=0){a.index=next;a.highlight();}}
    };
    select.addEventListener('change',refreshCustomSelects);
  });
  for(const [select,{button,text}]of customSelects){const label=select.selectedOptions[0]?.textContent||'';if(text.textContent!==label)text.textContent=label;button.disabled=select.disabled;const name=select.getAttribute('aria-label')||Array.from(select.closest('label')?.childNodes||[]).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent.trim()).join(' ')||label;const aria=name+' · '+label;if(button.getAttribute('aria-label')!==aria)button.setAttribute('aria-label',aria);}
  for(const [attr,id]of [['format','exportFormat'],['processing','normalize']])document.querySelectorAll('[data-'+attr+']').forEach(button=>{const checked=button.dataset[attr]===document.getElementById(id).value;if(button.getAttribute('aria-checked')!==String(checked))button.setAttribute('aria-checked',String(checked));button.tabIndex=checked?0:-1;});
}
function openCustomSelect(select){
  closeCustomSelect();const entry=customSelects.get(select);if(!entry||select.disabled)return;
  const {button}=entry,options=[...select.options].filter(o=>!o.disabled&&!o.hidden),popup=document.createElement('div');popup.className='select-popup';popup.id='select-popup-'+(++selectSequence);popup.setAttribute('role','listbox');popup.setAttribute('popover','manual');popup.setAttribute('aria-label',button.getAttribute('aria-label'));if(!options.length)return;
  const state={select,button,popup,options,index:Math.max(0,options.findIndex(o=>o.value===select.value))};activeSelect=state;
  state.choose=index=>{if(!options[index])return;select.value=options[index].value;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));closeCustomSelect();refreshCustomSelects();button.focus();};
  state.highlight=()=>{[...popup.children].forEach((option,index)=>option.classList.toggle('is-active',index===state.index));const active=popup.children[state.index];if(!active)return;button.setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'});};
  options.forEach((option,index)=>{const row=document.createElement('div');row.id=popup.id+'-'+index;row.className='select-option';row.setAttribute('role','option');row.setAttribute('aria-selected',String(option.value===select.value));row.textContent=option.textContent;row.onpointerdown=e=>e.preventDefault();row.onclick=e=>{e.preventDefault();state.choose(index);};row.onpointermove=()=>{state.index=index;state.highlight();};popup.append(row);});
  (select.closest('dialog')||document.body).append(popup);popup.showPopover();const rect=button.getBoundingClientRect(),height=Math.min(options.length*33+10,240);popup.style.width=Math.max(rect.width,120)+'px';popup.style.left=Math.min(rect.left,innerWidth-Math.max(rect.width,120)-8)+'px';popup.style.top=(innerHeight-rect.bottom>=height+8?rect.bottom+5:Math.max(8,rect.top-height-5))+'px';popup.style.maxHeight=height+'px';button.setAttribute('aria-expanded','true');button.setAttribute('aria-controls',popup.id);state.highlight();
}
document.addEventListener('pointerdown',event=>{if(activeSelect&&!activeSelect.popup.contains(event.target)&&!activeSelect.button.contains(event.target))closeCustomSelect();},true);
document.addEventListener('close',closeCustomSelect,true);window.addEventListener('resize',closeCustomSelect);
function setupExportDesign(){
 for(const [attr,id]of [['format','exportFormat'],['processing','normalize']]){
  const buttons=[...document.querySelectorAll('[data-'+attr+']')];
  const select=button=>{const source=document.getElementById(id);source.value=button.dataset[attr];source.dispatchEvent(new Event('change',{bubbles:true}));refreshCustomSelects();};
  buttons.forEach((button,index)=>{button.onclick=()=>select(button);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;select(buttons[next]);buttons[next].focus();};});
 }
 refreshCustomSelects();
}
window.customSelectRefresh=refreshCustomSelects;
