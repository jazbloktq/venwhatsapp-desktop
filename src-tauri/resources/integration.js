(function () {
  "use strict";
  function L(pt, en) { return window.__WR_LANG === "en" ? en : pt; }
  if (!(window.__WHATRUST_WINDOWS__ || window.__WHATRUST_SINGLE__) || location.origin !== "https://web.whatsapp.com") return;
  var state = { accounts: [], current_id: "", native_notifications: false };
  var host, root, menu, gear, accountButton, accountAvatar, accountName, accountBadge, status, lastReport = "", observer, scheduled, resizeObserver, resizeTarget, themeObserver, profileInFlight = false, lastProfileSignature = "";
  function call(cmd, args) { var t=window.__TAURI__;if(!t||!t.core)return Promise.resolve(null);return t.core.invoke(cmd, args).catch(function () { return null; }); }
  function button(text, fn) { var b=document.createElement("button");b.type="button";b.textContent=text;b.addEventListener("click",function(e){e.stopPropagation();fn();});return b; }
  function openPanel() { if(menu.open)menu.close();call("open_app_panel"); }
  function initials(name) { return String(name||"?").trim().split(/\s+/).slice(0,2).map(function(part){return part[0]||"";}).join("").toUpperCase()||"?"; }
  function fillAvatar(node, account) { node.replaceChildren();node.classList.toggle("has-photo",!!(account&&account.photo));if(account&&account.photo){var img=document.createElement("img");img.src=account.photo;img.alt="";node.appendChild(img);}else node.textContent=initials(account&&account.name); }
  function positionMenu(){var r=accountButton.getBoundingClientRect(),below=Math.max(0,innerHeight-12-r.bottom-8),above=Math.max(0,r.top-20),natural=menu.scrollHeight+2,down=below>=natural||below>=above;menu.style.maxHeight=Math.max(40,Math.min(innerHeight-24,down?below:above))+"px";var height=menu.offsetHeight;menu.style.top=Math.max(12,Math.min(down?r.bottom+8:r.top-height-8,innerHeight-height-12))+"px";menu.style.left=Math.max(12,Math.min(r.left,innerWidth-menu.offsetWidth-12))+"px";}

  function draw() {
    if(!accountButton)return;
    var focusKey=root.activeElement && root.activeElement.dataset.item;
    var keepFocus=menu.open && !!focusKey;
    var own=state.accounts.find(function(a){return a.id===state.current_id;});
    fillAvatar(accountAvatar,own);
    accountName.textContent=own ? own.name : L("Contas","Accounts");
    accountBadge.textContent=own && own.unread ? String(own.unread>99?"99+":own.unread) : "";
    accountBadge.hidden=!accountBadge.textContent;
    accountButton.setAttribute("aria-label",L("Trocar conta","Switch account")+(own?": "+own.name:"")+(own&&own.unread?" · "+own.unread+L(" conversas não lidas"," unread chats"):""));
    accountButton.title=own ? L("Conta: ","Account: ")+own.name+L(" — Trocar conta"," — Switch account") : L("Trocar conta do WhatsApp","Switch WhatsApp account");
    gear.setAttribute("aria-label",L("Configurações do Venwhatsapp","Venwhatsapp settings"));gear.title=L("Configurações do Venwhatsapp","Venwhatsapp settings");menu.setAttribute("aria-label",L("Contas do Venwhatsapp","Venwhatsapp accounts"));
    menu.replaceChildren();
    var heading=document.createElement("div");heading.className="menu-heading";
    var title=document.createElement("h2");title.textContent=L("Suas contas","Your accounts");heading.appendChild(title);
    var close=button("×",function(){menu.close();});close.className="menu-close";close.setAttribute("aria-label",L("Fechar","Close"));close.dataset.item="close";heading.appendChild(close);menu.appendChild(heading);
    var list=document.createElement("div");list.className="account-list";
    state.accounts.forEach(function(a){
      var b=button("",function(){menu.close();call("switch_account",{id:a.id});});b.className="account-item";b.setAttribute("aria-current",String(a.id===state.current_id));b.dataset.item=a.id;
      var avatar=document.createElement("span");avatar.className="item-avatar";fillAvatar(avatar,a);
      var copy=document.createElement("span");copy.className="item-copy";
      var name=document.createElement("span");name.className="item-name";name.textContent=a.name;
      var detail=document.createElement("span");detail.className="item-detail";detail.textContent=a.id===state.current_id?L("Conta atual","Current account"):a.detached?L("Janela separada","Separate window"):L("WhatsApp","WhatsApp");
      copy.append(name,detail);b.append(avatar,copy);
      if(a.unread){var unread=document.createElement("span");unread.className="item-unread";unread.textContent=String(a.unread>99?"99+":a.unread);unread.setAttribute("aria-label",a.unread+L(" conversas não lidas"," unread chats"));b.appendChild(unread);}
      if(a.id===state.current_id){var check=document.createElement("span");check.className="item-check";check.textContent="✓";check.setAttribute("aria-hidden","true");b.appendChild(check);}
      list.appendChild(b);
    });
    menu.appendChild(list);
    var manage=button(L("Gerenciar contas e configurações","Manage accounts and settings"),openPanel);manage.className="manage-button";manage.dataset.item="manage";menu.appendChild(manage);
    status=document.createElement("p");status.className="menu-status";status.setAttribute("role","status");status.textContent=own?L("Conta atual: ","Current account: ")+own.name:L("Escolha uma conta","Choose an account");menu.appendChild(status);
    if(menu.open)positionMenu();
    if(keepFocus){var restore=Array.from(menu.querySelectorAll("button")).find(function(b){return b.dataset.item===focusKey;})||menu.querySelector("button");if(restore)restore.focus();}
  }
  window.__wrRelang=function(){if(accountButton)draw();};
  window.__whatrustState=function(next){if(!next)return;state=next;window.__whatrustPreferNative=!!next.native_notifications;window.__whatrustNotificationEpoch=next.notification_epoch||0;window.__whatrustLocked=!!next.notifications_locked;draw();};
  function create(){
    host=document.createElement("span");host.id="__whatrust_controls";host.setAttribute("data-whatrust","controls");
    host.style.cssText="display:inline-flex;position:relative;align-items:center;flex:0 0 auto;max-width:min(270px,calc(100vw - 16px));margin-inline-start:8px;align-self:center";
    root=host.attachShadow({mode:"open"});
    var style=document.createElement("style");style.textContent=`
      :host{color-scheme:light dark;color:light-dark(#111b21,#e9edef);font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}
      button{font:inherit;cursor:pointer;border:0;background:transparent;color:inherit;transition:background-color .14s,color .14s,transform .14s}
      button:hover{background:light-dark(#0000000c,#ffffff12)}button:active{transform:scale(.985)}button:focus-visible{outline:2px solid #21c063;outline-offset:2px}
      .bar{pointer-events:auto;display:flex;align-items:center;justify-content:center;gap:5px;padding:6px;background:light-dark(#f7f8f8f2,#202c33f2);border:1px solid light-dark(#dfe3e5,#34454d);border-top:0;border-radius:0 0 16px 16px;box-shadow:0 10px 32px #0003;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
      .bar>button{display:inline-flex;align-items:center;justify-content:center;flex:none;height:38px;min-width:38px;padding:6px;border-radius:20px}
      .bar>.account{gap:8px;max-width:min(270px,calc(100vw - 64px));padding:4px 10px 4px 5px;border:1px solid light-dark(#d8dfe2,#3b4a50);background:light-dark(#fff,#26363e);border-radius:24px}
      .bar>.account:hover{background:light-dark(#f2f5f5,#2b414a)}
      .account-avatar,.item-avatar{display:grid;place-items:center;flex:none;overflow:hidden;border-radius:50%;background:light-dark(#dfe5e7,#34454d);color:light-dark(#41525a,#e9edef);font-weight:600;letter-spacing:.01em}
      .account-avatar{width:27px;height:27px;font-size:10px}.item-avatar{width:38px;height:38px;font-size:12px;border:1px solid light-dark(#dce2e4,#3a4a51)}
      .account-avatar.has-photo,.item-avatar.has-photo{background:transparent}.account-avatar img,.item-avatar img{display:block;width:100%;height:100%;object-fit:cover;border-radius:50%}
      .account-name{min-width:0;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
      :host([data-compact="true"]) .account-name{display:none}
      .account-chevron{font-size:15px;line-height:1;color:light-dark(#65747a,#b7c4c9);margin-inline-start:1px}
      .gear{color:light-dark(#546269,#d1d9dc)}.gear svg{width:20px;height:20px}
      .badge{flex:none;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#21c063;color:#062d17;font:600 10px/17px system-ui;text-align:center}
      [hidden]{display:none!important}svg{width:24px;height:24px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
      dialog{position:fixed;color-scheme:light dark;color:light-dark(#111b21,#e9edef);background:light-dark(#fff,#202c33);border:1px solid light-dark(#dfe3e5,#34454d);border-radius:16px;box-shadow:0 18px 52px #0005;width:350px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;padding:8px;inset:auto;margin:0;scrollbar-width:thin;scrollbar-color:rgba(134,150,160,.45) transparent;transform-origin:top center}
      dialog[open]{animation:menu-enter .18s cubic-bezier(.2,.8,.2,1) both}@keyframes menu-enter{from{opacity:0;transform:translateY(-5px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
      dialog::-webkit-scrollbar{width:8px}dialog::-webkit-scrollbar-track{background:transparent}dialog::-webkit-scrollbar-thumb{background-color:rgba(134,150,160,.45);border:2px solid transparent;border-radius:4px;background-clip:padding-box}
      dialog::backdrop{background:transparent}.menu-heading{display:flex;align-items:center;justify-content:space-between;padding:7px 8px 10px;border-bottom:1px solid light-dark(#edf0f1,#34444a)}
      h2{font-size:16px;font-weight:650;letter-spacing:-.01em;margin:0}.menu-close{width:30px;height:30px;border-radius:50%;font-size:20px;line-height:1;color:light-dark(#66767c,#adbac0)}
      .account-list{display:flex;flex-direction:column;gap:2px;padding:6px 0}.account-item{display:flex;align-items:center;gap:10px;width:100%;min-width:0;text-align:left;padding:8px;border-radius:11px;overflow:hidden}
      .account-item[aria-current=true]{background:light-dark(#eaf7ef,#18382a)}.account-item:hover{background:light-dark(#f1f4f4,#2a3b42)}.account-item[aria-current=true]:hover{background:light-dark(#e2f3e8,#204331)}
      .item-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}.item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}.item-detail{color:light-dark(#66767c,#aab7bc);font-size:11px}
      .item-unread{flex:none;min-width:20px;padding:2px 6px;border-radius:10px;background:#21c063;color:#062d17;text-align:center;font-size:10px;font-weight:700}.item-check{flex:none;padding:0 4px;color:#12a454;font-size:16px;font-weight:700}
      .manage-button{display:flex;align-items:center;justify-content:center;width:100%;margin-top:3px;padding:10px;border-radius:10px;background:light-dark(#f2f5f5,#293b42);font-weight:600}.manage-button:hover{background:light-dark(#e8eeee,#31474f)}
      .menu-status{font-size:11px;color:light-dark(#77858a,#9aa9af);margin:9px 8px 3px}
      @media(prefers-reduced-motion:reduce){*,dialog[open]{animation:none!important;transition:none!important}}
    `;
    var bar=document.createElement("div");bar.className="bar";
    accountButton=button("Contas",function(){draw();if(!menu.open)menu.showModal();positionMenu();accountButton.setAttribute("aria-expanded","true");var b=menu.querySelector('.account-item[aria-current="true"]')||menu.querySelector(".account-item")||menu.querySelector("button");if(b)b.focus();});accountButton.className="account";accountButton.textContent="";
    accountAvatar=document.createElement("span");accountAvatar.className="account-avatar";accountAvatar.setAttribute("aria-hidden","true");
    accountName=document.createElement("span");accountName.className="account-name";
    var chevron=document.createElement("span");chevron.className="account-chevron";chevron.textContent="⌄";chevron.setAttribute("aria-hidden","true");
    accountBadge=document.createElement("span");accountBadge.className="badge";accountBadge.setAttribute("aria-hidden","true");
    accountButton.append(accountAvatar,accountName,accountBadge,chevron);accountButton.setAttribute("aria-haspopup","dialog");accountButton.setAttribute("aria-expanded","false");
    gear=button("",openPanel);gear.className="gear";gear.setAttribute("aria-label","Configurações do Venwhatsapp");gear.title="Configurações do Venwhatsapp";
    gear.textContent="";
    // Gear path: Lucide "settings" icon (ISC licence, https://lucide.dev).
    var svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),path=document.createElementNS("http://www.w3.org/2000/svg","path");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");path.setAttribute("d","M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0");svg.appendChild(path);gear.appendChild(svg);
    menu=document.createElement("dialog");menu.setAttribute("aria-label","Contas do Venwhatsapp");menu.addEventListener("click",function(e){var r=menu.getBoundingClientRect();if(e.target===menu&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))menu.close();});menu.addEventListener("close",function(){accountButton.setAttribute("aria-expanded","false");accountButton.focus();});
    bar.append(accountButton,gear);root.append(style,bar,menu);draw();
  }
  function resolvedTheme(){
    var candidate=anchor();var header=candidate&&candidate.header,c=header&&getComputedStyle(header).color;
    var rgb=c&&c.match(/[\d.]+/g);
    if(rgb&&rgb.length>=3)return .2126*+rgb[0]+.7152*+rgb[1]+.0722*+rgb[2]>140?"dark":"light";
    return matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
  }
  function report(mounted,detector){var theme=resolvedTheme();if(root){root.host.style.colorScheme=theme;root.host.dataset.theme=theme;}var value=mounted+":"+detector+":"+theme;if(value===lastReport)return;lastReport=value;var t=window.__TAURI__;if(!t||!t.core){lastReport="";return;}t.core.invoke("report_integration",{mounted:mounted,detector:detector,theme:theme}).catch(function(){lastReport="";});}
  function horizontal(e){
    var r=e.getBoundingClientRect(),style=getComputedStyle(e);
    return r.width>=260 && r.height>=36 && r.height<=100 && r.width>r.height*2 && style.visibility!=="hidden" && style.display!=="none";
  }
  function anchor(){
    var side=document.getElementById("side")||document.getElementById("pane-side"),sideBox=side&&side.getBoundingClientRect();
    var candidates=Array.from(document.querySelectorAll("#app header,#app [role=banner]"))
      .filter(function(e){
        if(e.closest("#main")||!horizontal(e))return false;
        var r=e.getBoundingClientRect();
        // In current WhatsApp the conversation-list header is a sibling of #side.
        // Its navigation rail is ALSO a header. Never select by document order.
        if(sideBox && sideBox.width>0)return Math.abs(r.left-sideBox.left)<=24 && Math.abs(r.width-sideBox.width)<=48 && (side.contains(e)||(r.bottom<=sideBox.top+4 && sideBox.top-r.bottom<=100));
        return !!e.querySelector("h1,h2,[role=heading]");
      });
    var header=candidates.find(function(e){return !candidates.some(function(other){return other!==e&&e.contains(other);});});
    if(!header)return null;
    var width=header.getBoundingClientRect().width;
    var rows=Array.from(header.querySelectorAll("div,section")).slice(0,32).filter(function(e){
      var c=getComputedStyle(e),r=e.getBoundingClientRect();return horizontal(e)&&c.display==="flex"&&c.flexDirection==="row"&&r.width>=width-48&&!!e.querySelector("button,[role=button]");
    });
    var row=rows.find(function(e){return !rows.some(function(other){return other!==e&&e.contains(other);});});
    if(!row){var c=getComputedStyle(header);if(c.display!=="flex"||c.flexDirection!=="row")return null;row=header;}
    return {header:header,row:row};
  }
  function fits(target){
    var area=target.header.getBoundingClientRect(),r=host.getBoundingClientRect();
    if(r.width<84||r.height<32||r.left<area.left||r.right>area.right+1||r.top<area.top||r.bottom>area.bottom+1)return false;
    return !Array.from(target.header.querySelectorAll("button,[role=button],h1,h2,[role=heading]")).some(function(e){
      if(host.contains(e))return false;var b=e.getBoundingClientRect();return b.width>0&&b.height>0&&r.left<b.right-1&&r.right>b.left+1&&r.top<b.bottom-1&&r.bottom>b.top+1;
    });
  }
  function mount(){
    var target=anchor();if(!host)create();
    var resizeNode=document.getElementById("side")||document.documentElement;
    if(resizeObserver&&resizeTarget!==resizeNode){resizeObserver.disconnect();resizeObserver.observe(resizeNode);resizeTarget=resizeNode;}
    if(target){
      host.dataset.compact=String(target.header.getBoundingClientRect().width<560);
      if(host.parentNode!==target.row){if(menu.open)menu.close();target.row.appendChild(host);}
      if(!fits(target)&&host.dataset.compact!=="true")host.dataset.compact="true";
      if(!fits(target)){host.remove();target=null;}
    }else if(host.isConnected)host.remove();
    report(!!target,messageRows().length>0);
    scanMessages();
    if(menu.open)positionMenu();
    // Consume our own insertion/removal records after processing this layout.
    // Otherwise an unsuitable header causes append/remove retries every 200ms.
    if(observer)observer.takeRecords();
  }
  function schedule(){if(scheduled)return;scheduled=setTimeout(function(){scheduled=0;mount();},200);}
  // Adapter contract: only mounted message IDs/direction and explicit mute state.
  // No React internals, message text, chat names, or contacts are read.
  var cursor=null, chat=null, baseline=0, muteKnown=null, sent=new Set(), lastMenuText="", menuChat=null, menuTime=0;
  document.addEventListener("click",function(e){var item=e.target.closest && e.target.closest("[role=menuitem]");if(item){muteKnown=null;return;}var control=e.target.closest && e.target.closest("#main header button,#main header [role=button]");if(control){menuChat=chat;menuTime=Date.now();}},true);
  function messageRows(){var main=document.getElementById("main");return main?Array.from(main.querySelectorAll("[data-id]")).filter(function(e){return /^(true|false)_[^_]+_.+/.test(e.getAttribute("data-id")||"");}):[];}
  function muteState(){
    var main=document.getElementById("main");if(!main)return null;
    if(main.querySelector('header[data-muted="true"], header [data-muted="true"], header [data-icon="muted"], header [data-icon="muted-alt"]'))return true;
    if(main.querySelector('header[data-muted="false"], header [data-muted="false"]'))return false;
    // Only explicit, visible actions prove the opposite current state. These
    // bounded labels belong to this adapter, never to the mounting algorithm.
    var actions=Array.from(document.querySelectorAll('[role="menuitem"],[role="menu"] button,[role="menu"] [role="button"]')).filter(function(e){return e.getClientRects().length;});
    var text=actions.map(function(e){return e.textContent.trim().toLowerCase();}).join("|");
    if(menuChat===chat && Date.now()-menuTime<5000 && text){lastMenuText=text;if(actions.some(function(e){return /^(unmute notifications|reativar notificações|ativar notificações)$/.test(e.textContent.trim().toLowerCase());}))muteKnown=true;
      else if(actions.some(function(e){return /^(mute notifications|silenciar notificações)$/.test(e.textContent.trim().toLowerCase());}))muteKnown=false;}
    return muteKnown;
  }
  async function send(row,muted){
    var id=row.getAttribute("data-id");if(sent.has(id))return;sent.add(id);if(sent.size>1024)sent.delete(sent.values().next().value);
    if(!crypto.subtle)return;
    var bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(id));
    var key=Array.from(new Uint8Array(bytes)).map(function(b){return b.toString(16).padStart(2,"0");}).join("");
    await call("report_message_signal",{signal:{id:key,active:true,muted:muted}});
  }
  function scanMessages(){
    var rows=messageRows();if(!rows.length){cursor=null;chat=null;return;}
    var end=rows[rows.length-1].getAttribute("data-id"), current=end.split("_")[1];
    if(current!==chat){chat=current;cursor=end;baseline=Date.now();muteKnown=null;lastMenuText="";rows.forEach(function(r){sent.add(r.getAttribute("data-id"));});return;}
    var muted=muteState();
    if(end===cursor)return;
    var index=rows.findIndex(function(r){return r.getAttribute("data-id")===cursor;});
    cursor=end;
    // Disappearing anchor = virtualization/reconnect/history, not proof of news.
    if(index<0 || Date.now()-baseline<2500)return;
    rows.slice(index+1).filter(function(r){return r.getAttribute("data-id").startsWith("false_");}).forEach(function(r){send(r,muted);});
  }
  function imageSource(value){
    if(!value)return null;
    if(typeof value==="string")return {src:value,temporary:false};
    if(typeof HTMLImageElement!=="undefined"&&value instanceof HTMLImageElement)return {src:value.currentSrc||value.src,temporary:false};
    if(typeof Blob!=="undefined"&&value instanceof Blob)return {src:URL.createObjectURL(value),temporary:true};
    if(typeof value==="object")return imageSource(value.src||value.url||value.eurl||value.imgFull||value.img);
    return null;
  }
  async function profilePhotoPng(thumb){
    if(!thumb)return null;
    var candidates=[thumb.imgFull,thumb.img,thumb.eurl,thumb.url,thumb];
    for(var i=0;i<candidates.length;i++){
      var candidate=imageSource(candidates[i]);if(!candidate||!candidate.src)continue;
      try{
        var img=new Image();if(/^https:/i.test(candidate.src))img.crossOrigin="anonymous";img.src=candidate.src;
        await new Promise(function(resolve){if(img.complete){resolve();return;}img.onload=resolve;img.onerror=resolve;setTimeout(resolve,3500);});
        if(!img.naturalWidth||!img.naturalHeight)continue;
        var side=Math.min(img.naturalWidth,img.naturalHeight),canvas=document.createElement("canvas");canvas.width=canvas.height=96;
        canvas.getContext("2d").drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,96,96);
        var blob=await new Promise(function(resolve){canvas.toBlob(resolve,"image/png");});if(!blob||blob.size>100*1024)continue;
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }catch(_){
      }finally{if(candidate.temporary)URL.revokeObjectURL(candidate.src);}
    }
    return null;
  }
  function profileSignature(name,png){var hash=2166136261;if(png)for(var i=0;i<png.length;i++)hash=Math.imul(hash^png[i],16777619);return name+"|"+(png?(hash>>>0).toString(16):"no-photo");}
  async function syncWhatsAppProfile(){
    if(profileInFlight||!window.WPP||!window.WPP.profile||typeof window.WPP.profile.getMyProfileName!=="function")return;
    profileInFlight=true;
    try{
      var name=String(window.WPP.profile.getMyProfileName()||"").trim().slice(0,128),thumb=null,png=null;
      if(typeof window.WPP.profile.getMyProfilePicture==="function"){
        try{thumb=await window.WPP.profile.getMyProfilePicture();png=await profilePhotoPng(thumb);}catch(_){png=null;}
      }
      if(!name&&!png)return;
      var signature=profileSignature(name,png);if(signature===lastProfileSignature)return;
      var t=window.__TAURI__;if(!t||!t.core)return;
      await t.core.invoke("sync_whatsapp_profile",{profileName:name,photoPng:png});
      lastProfileSignature=signature;
    }catch(_){
    }finally{profileInFlight=false;}
  }
  function start(){
    if(!document.body)return;
    observer=new MutationObserver(function(records){if(records.some(function(r){return !host || !host.contains(r.target);}))schedule();});
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["data-id","data-muted"]});
    if(window.ResizeObserver)resizeObserver=new ResizeObserver(schedule);
    themeObserver=new MutationObserver(schedule);
    themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:["class","style","data-theme"]});
    themeObserver.observe(document.body,{attributes:true,attributeFilter:["class","style","data-theme"]});
    window.addEventListener("resize",mount);
    mount();call("integration_state").then(window.__whatrustState);
    setInterval(function(){call("integration_state").then(window.__whatrustState);mount();},10000);
    syncWhatsAppProfile();var profileTimer=setInterval(syncWhatsAppProfile,30000);
    var profileProbe=setInterval(function(){if(window.WPP&&window.WPP.profile&&typeof window.WPP.profile.getMyProfileName==="function"){clearInterval(profileProbe);syncWhatsAppProfile();}},1000);
    window.addEventListener("pagehide",function(){observer.disconnect();if(resizeObserver)resizeObserver.disconnect();themeObserver.disconnect();window.removeEventListener("resize",mount);clearInterval(profileTimer);clearInterval(profileProbe);});
  }
  if(document.body)start();else document.addEventListener("DOMContentLoaded",start,{once:true});
})();
