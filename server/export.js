import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const colors = { ink:'FF171717', accent:'FF171717', pale:'FFF5F5F5', line:'FFDEDEDE', white:'FFFFFFFF', muted:'FF626262' };
const statuses = { active:'В процессе', submitted:'Завершён', expired:'Время истекло', invalidated:'Аннулирован' };
const eventNames = { blur:'Потеря фокуса', visibility:'Скрытие вкладки', paste:'Вставка', fullscreen:'Выход из полного экрана', rules_accepted:'Правила приняты', start:'Начало', answers:'Ответы сохранены', check:'Ответ проверен', presence:'Состояние вкладки изменено', question:'Переход к вопросу', submitted:'Отправлено', expired:'Время истекло', invalidated:'Аннулировано', retake_granted:'Пересдача разрешена', retake_started:'Пересдача начата' };
const typeNames = { single:'Один вариант', multiple:'Несколько вариантов', short:'Короткий текст', long:'Развёрнутый текст', matching:'Соответствие', content:'Информация', truefalse:'Верно / неверно', number:'Число', ordering:'Порядок элементов', dropdown:'Выпадающий список', rating:'Рейтинг', scale:'Шкала', date:'Дата' };
const literal = value => value == null ? '' : typeof value === 'string' ? value.slice(0,32000) : value;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const revisionOf = value => Number.isSafeInteger(value?.contentRevision) && value.contentRevision > 0 ? value.contentRevision : 1;
const exportQuestion = q => ({...q, answerKey:Object.hasOwn(q,'answerKey') ? q.answerKey : q.correct});
const optionsText = q => [...(q.options || [])].sort((a,b)=>String(a.id).localeCompare(String(b.id))).map((o,i)=>`${i+1}. ${o.text}`).join('\n');
const questionParts = q => q.type === 'matching' ? `Слева:\n${(q.pairs||[]).map(p=>p.left).join('\n')}\nВарианты справа:\n${[...new Set((q.pairs||[]).map(p=>p.right))].sort().join('\n')}` : optionsText(q);
const readable = (q,answer) => {
  if(answer === undefined || answer === null || answer === '') return '—';
  const option = id => q?.options?.find(o=>o.id===id)?.text || String(id);
  if(Array.isArray(answer)) return answer.map(option).join(q?.type==='ordering' ? ' → ' : '; ');
  if(typeof answer==='object') return Object.entries(answer).map(([id,value])=>`${q?.pairs?.find(p=>p.id===id)?.left || id}: ${value}`).join('\n');
  return ['single','truefalse','dropdown'].includes(q?.type) ? option(answer) : String(answer);
};
const keyText = q => q.type==='matching' ? (q.pairs||[]).map(p=>`${p.left} — ${p.right}`).join('\n') : readable(q,q.answerKey)+(q.type==='number'&&q.tolerance ? ` ± ${q.tolerance}` : '');
function sheet(workbook,name,headers,widths) {
  const ws=workbook.addWorksheet(name,{
    properties:{tabColor:{argb:colors.accent},defaultRowHeight:24},
    pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:1',margins:{left:.25,right:.25,top:.5,bottom:.5,header:.2,footer:.2}},
    headerFooter:{oddHeader:'&LForma&CОтчёт',oddFooter:'&LКонфиденциальные данные&C&P / &N&RВсе даты — UTC'},
    views:[{state:'frozen',ySplit:1,showGridLines:false}]
  });
  ws.columns=widths.map(width=>({width}));
  if(headers)ws.addRow(headers);
  return ws;
}
function table(ws,maxHeight=120) {
  ws.eachRow((row,i)=>{
    row.font={name:'Calibri',size:11,color:{argb:colors.ink}};
    row.alignment={vertical:'middle',wrapText:true};
    row.height=i===1 ? 34 : 30;
    row.eachCell({includeEmpty:true},cell=>{
      cell.value=literal(cell.value);
      cell.border={bottom:{style:'hair',color:{argb:colors.line}}};
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:i===1 ? colors.accent : i%2 ? colors.white : colors.pale}};
      if(i===1)cell.font={name:'Calibri',size:11,bold:true,color:{argb:colors.white}};
      else row.height=Math.max(row.height,Math.min(maxHeight,String(cell.value).split('\n').length*15+12));
    });
  });
  if(ws.rowCount>1)ws.autoFilter={from:'A1',to:{row:ws.rowCount,column:ws.columnCount}};
}
export async function exportReport(report,{variant='public'}={}) {
  if(!['public','private'].includes(variant))throw new Error('Unknown report variant');
  const privateFile=variant==='private',survey=report.kind==='survey';
  const form=report.quiz||report.survey||{},rows=report.attempts||report.responses||[],questions=report.questions||[],s=report.summary||{};
  const currentRevision=revisionOf(form);
  const revisionMap=new Map((report.revisions||[]).map(revision=>[revisionOf(revision),revision]));
  if(!revisionMap.has(currentRevision))revisionMap.set(currentRevision,{contentRevision:currentRevision,title:form.title,questions});
  const definitions=new Map();
  for(const [revision,entry] of revisionMap)for(const q of entry.questionDefinitions||entry.questions||[]){const stats=entry.questions?.find(item=>item.id===q.id);definitions.set(`${revision}\0${q.id}`,{...exportQuestion(q),...(stats?.aggregates?{aggregates:stats.aggregates}:{}),contentRevision:revision});}
  for(const a of rows)for(const q of a.questions||[])if(!definitions.has(`${revisionOf(a)}\0${q.id}`))definitions.set(`${revisionOf(a)}\0${q.id}`,{...exportQuestion(q),contentRevision:revisionOf(a)});
  if(privateFile)for(const a of rows)for(const entry of a.history||[]){const history=entry.doc||entry;for(const q of history.snapshot?.questions||[])if(!definitions.has(`${revisionOf(history.snapshot)}\0${q.id}`))definitions.set(`${revisionOf(history.snapshot)}\0${q.id}`,{...exportQuestion(q),contentRevision:revisionOf(history.snapshot)});}
  const questionDefinitions=[...definitions.values()].sort((a,b)=>a.contentRevision-b.contentRevision);
  const rowQuestions=a=>(a.questions||revisionMap.get(revisionOf(a))?.questionDefinitions||revisionMap.get(revisionOf(a))?.questions||questions).map(exportQuestion);
  const workbook=new ExcelJS.Workbook();
  workbook.creator='Forma';workbook.created=new Date();
  workbook.subject=privateFile ? 'Приватный отчёт с ответами' : 'Публичный отчёт без ответов';
  const cover=sheet(workbook,'Summary',null,[24,19,17,17,3,20,16,3,4,24,16]);
  cover.mergeCells('A1:K2');cover.getCell('A1').value='FORMA / ОТЧЁТ';
  cover.getCell('A1').font={name:'Calibri',size:24,bold:true,color:{argb:colors.white}};
  cover.getCell('A1').fill={type:'pattern',pattern:'solid',fgColor:{argb:colors.accent}};
  cover.getCell('A1').alignment={vertical:'middle',indent:1};
  cover.mergeCells('A3:K3');cover.getCell('A3').value=literal(form.title);cover.getRow(3).height=34;
  cover.getCell('A3').font={name:'Calibri',size:18,bold:true,color:{argb:colors.ink}};
  cover.mergeCells('A4:K4');cover.getCell('A4').value=`${survey?'Опрос':'Квиз'} · ${privateFile?'Приватный · содержит ответы':'Публичный · без ответов и ключей'} · ${new Date().toISOString()}`;
  cover.getCell('A4').font={name:'Calibri',size:11,color:{argb:colors.muted}};
  const stats=[['Всего участников',s.total],['Завершили',s.submitted],['Сейчас проходят',s.active],['Время истекло',s.expired],['Аннулированы',s.invalidated||0]];
  if(!survey)stats.push([`Средний результат версии ${currentRevision}, %`,s.averagePercent]);
  stats.forEach(([label,value],i)=>{
    const n=i+7;cover.mergeCells(`A${n}:C${n}`);cover.getCell(`A${n}`).value=label;cover.getCell(`D${n}`).value=number(value);cover.getRow(n).height=30;
    cover.getCell(`D${n}`).font={name:'Calibri',size:16,bold:true,color:{argb:colors.accent}};
    for(const col of ['A','B','C','D'])cover.getCell(`${col}${n}`).fill={type:'pattern',pattern:'solid',fgColor:{argb:colors.pale}};
  });
  const bins=[0,0,0,0,0];for(const a of rows)if(a.status!=='active'&&revisionOf(a)===currentRevision)bins[Math.min(4,Math.max(0,Math.floor(number(a.percent)/20)))]++;
  const barLabels=survey ? ['Завершили','В процессе','Истекли'] : ['0–19%','20–39%','40–59%','60–79%','80–100%'];
  const barData=survey ? [s.submitted||0,s.active||0,s.expired||0] : bins;
  cover.getCell('F6').value=survey?'Состояние':'Результат';cover.getCell('G6').value='Участников';
  barLabels.forEach((v,i)=>{cover.getCell(i+7,6).value=v;cover.getCell(i+7,7).value=barData[i]});
  const statusLabels=['Завершили','Время истекло','Аннулированы','В процессе'],statusData=[s.submitted||0,s.expired||0,s.invalidated||0,s.active||0];
  cover.getCell('J6').value='Статус';cover.getCell('K6').value='Участников';
  statusLabels.forEach((v,i)=>{cover.getCell(i+7,10).value=v;cover.getCell(i+7,11).value=statusData[i]});
  for(const c of ['F6','G6','J6','K6'])cover.getCell(c).font={bold:true,color:{argb:colors.accent}};
  cover.mergeCells('A35:K35');cover.getCell('A35').value='IP и имена являются персональными данными. «Публичный» означает отчёт без ответов, а не общедоступную публикацию.';
  cover.mergeCells('A36:K36');cover.getCell('A36').value=survey ? 'Анонимные поля и несобираемые метаданные остаются пустыми. Статистика ответов доступна в приватной версии.' : `Среднее и распределение относятся к версии ${currentRevision}. Завершённые, истёкшие и аннулированные работы (0%). Все даты — UTC.`;
  for(const n of [35,36]){cover.getRow(n).height=30;cover.getCell(`A${n}`).alignment={wrapText:true};cover.getCell(`A${n}`).font={name:'Calibri',size:10,color:{argb:colors.muted}}}
  cover.pageSetup.printArea='A1:K36';
  const ah=['ID участника / работы','Имя','Группа','Статус','Начало (UTC)','Завершение (UTC)','Срок (UTC)','Длительность, сек.','IP','Предупреждения'];
  if(!survey)ah.push('Баллы','Макс. баллы','Результат, %');
  if(privateFile)ah.push('User-Agent','Последний сигнал (UTC)','Последнее действие','Время действия (UTC)',...(survey?['Сбор данных при старте (JSON)']:[]));
  ah.push('Версия вопросов');
  const attempts=sheet(workbook,'Attempts',ah,ah.map((_,i)=>[39,28,18,22,27,27,27,20,30,19,12,15,16][i]||30));
  for(const a of rows){
    const r=[a.id,a.name||'',a.group||'',statuses[a.status]||a.status,a.startedAt,a.finishedAt,a.expiresAt,a.durationSeconds,a.ip,a.warnings||0];
    if(!survey)r.push(a.score,a.maxScore,a.percent);
    if(privateFile)r.push(a.userAgent,a.presence?.lastSeenAt,eventNames[a.presence?.lastAction]||a.presence?.lastAction,a.presence?.lastActionAt);
    if(privateFile&&survey)r.push(JSON.stringify(a.collection||{}));
    r.push(revisionOf(a));
    attempts.addRow(r);
  }
  table(attempts);
  const versionSheet=sheet(workbook,'Versions',['Версия вопросов','Название','Всего работ','Завершены','Вопросов'],[20,75,20,20,20]);
  const versionNumbers=[...new Set(questionDefinitions.map(q=>q.contentRevision).concat([...revisionMap.keys()]))].sort((a,b)=>a-b);
  for(const version of versionNumbers){const entry=revisionMap.get(version),ownRows=rows.filter(a=>revisionOf(a)===version);versionSheet.addRow([version,entry?.title||form.title,entry?.summary?.total??ownRows.length,entry?.summary?.submitted??ownRows.filter(a=>a.status==='submitted').length,questionDefinitions.filter(q=>q.contentRevision===version&&q.type!=='content').length]);}
  table(versionSheet);
  if(!survey&&attempts.rowCount>1)attempts.addConditionalFormatting({ref:`M2:M${attempts.rowCount}`,rules:[{type:'dataBar',minLength:0,maxLength:100,cfvo:[{type:'num',value:0},{type:'num',value:100}],color:{argb:'FF999999'}}]});
  const qh=['ID вопроса','Тип','Вопрос','Варианты / элементы'];
  if(survey)qh.push('Обязательный','Диапазон');else qh.push('Макс. баллы');
  if(privateFile)qh.push(survey?'Статистика ответов':'Ключ правильного ответа');
  qh.push('Версия вопросов');
  const qs=sheet(workbook,'Questions',qh,[39,24,75,65,18,60,60,20]);
  for(const q of questionDefinitions){
    const r=[q.id,typeNames[q.type]||q.type,q.text,questionParts(q)];
    if(survey)r.push(q.required?'Да':'Нет',q.min!=null||q.max!=null?`${q.min??'—'} … ${q.max??'—'}`:'');else r.push(q.points);
    if(privateFile)r.push(survey?JSON.stringify(q.aggregates||q.statistics||q.aggregate||{}):keyText(q));
    r.push(q.contentRevision);
    qs.addRow(r);
  }
  table(qs,240);
  // Excel cells have a hard text limit. Keep each option on its own row so a
  // large set of long variants remains complete even when the overview is cut.
  const optionHeaders=['ID вопроса','Вопрос','Набор','ID элемента','Текст элемента'];
  if(privateFile&&!survey)optionHeaders.push('Ключ / правильная позиция');
  optionHeaders.push('Версия вопросов');
  const variants=sheet(workbook,'Options',optionHeaders,[39,70,24,39,90,30,20]);
  for(const q of questionDefinitions){
    for(const o of [...(q.options||[])].sort((a,b)=>String(a.id).localeCompare(String(b.id)))){
      const row=[q.id,q.text,'Вариант',o.id,o.text];
      if(privateFile&&!survey)row.push(Array.isArray(q.answerKey)?q.type==='ordering'?q.answerKey.indexOf(o.id)+1:q.answerKey.includes(o.id)?'Верно':'Неверно':'');
      row.push(q.contentRevision);
      variants.addRow(row);
    }
    if(q.type==='matching'){
      if(privateFile)for(const p of q.pairs||[])variants.addRow([q.id,q.text,'Соответствие',p.id,`${p.left}\n— ${p.right}`,'Верно',q.contentRevision]);
      else{
        for(const p of q.pairs||[])variants.addRow([q.id,q.text,'Слева',p.id,p.left,q.contentRevision]);
        for(const text of [...new Set((q.pairs||[]).map(p=>p.right))].sort())variants.addRow([q.id,q.text,'Варианты справа','',text,q.contentRevision]);
      }
    }
  }
  table(variants,240);
  // Explicit public allowlists: no answers, checked feedback, raw metadata,
  // private snapshots or historical response bodies enter the public ZIP.
  const eh=['ID работы','Имя','Группа','Событие','Время (UTC)','Предупреждение','Язык'];
  if(privateFile)eh.push('Подробности (JSON)');
  eh.push('Версия вопросов');
  const events=sheet(workbook,'Events',eh,[39,28,18,34,27,22,14,80,20]);
  for(const a of rows)for(const e of a.events||[]){
    const r=[a.id,a.name||'',a.group||'',eventNames[e.type]||e.type,e.createdAt,e.counted?'Да':'Нет',['ru','kk'].includes(e.metadata?.language)?e.metadata.language:''];
    if(privateFile)r.push(JSON.stringify(e.metadata||{}));r.push(revisionOf(a));events.addRow(r);
  }
  table(events);
  if(privateFile){
    const answers=sheet(workbook,'Answers',['ID работы','Имя','ID вопроса','Вопрос','Ответ участника','Исходный ответ (JSON)','Версия вопросов'],[39,28,39,70,70,70,20]);
    for(const a of rows)for(const [qid,value]of Object.entries(a.answers||{})){const q=rowQuestions(a).find(q=>q.id===qid);answers.addRow([a.id,a.name||'',qid,q?.text||'',readable(q,value),JSON.stringify(value),revisionOf(a)])}
    table(answers,240);
    const details=sheet(workbook,'AnswerDetails',['ID работы','Имя','ID вопроса','ID элемента','Ответ / элемент ответа','Исходное значение (JSON)','Версия вопросов'],[39,28,39,39,90,90,20]);
    for(const a of rows)for(const[qid,value]of Object.entries(a.answers||{})){
      const q=rowQuestions(a).find(q=>q.id===qid);
      const elements=Array.isArray(value)?value.map((item,i)=>[String(i+1),item]):value&&typeof value==='object'?Object.entries(value):[['',value]];
      for(const[element,item]of elements)details.addRow([a.id,a.name||'',qid,element,Array.isArray(value)?readable({...q,type:'single'},item):typeof value==='object'&&value!==null?`${q?.pairs?.find(p=>p.id===element)?.left||element}: ${item}`:readable(q,item),JSON.stringify(item),revisionOf(a)]);
    }
    table(details,240);
    const histories=rows.flatMap(a=>(a.history||[]).map(entry=>({...entry,currentId:a.id})));
    if(histories.length){
      const ws=sheet(workbook,'AttemptHistory',['ID текущей работы','ID предыдущей работы','Архивировано (UTC)','Статус','Начало (UTC)','Завершение (UTC)','Предупреждения','Баллы','Макс. баллы','Версия вопросов'],[39,39,27,24,27,27,20,15,18,20]);
      const ha=sheet(workbook,'HistoryAnswers',['ID текущей работы','ID предыдущей работы','ID вопроса','Вопрос','Ответ участника','Исходный ответ (JSON)','Ключ ответа','Версия вопросов'],[39,39,39,70,70,70,70,20]);
      const he=sheet(workbook,'HistoryEvents',['ID текущей работы','ID предыдущей работы','Событие','Время (UTC)','Предупреждение','Подробности (JSON)','Версия вопросов'],[39,39,34,27,22,80,20]);
      for(const entry of histories){
        const h=entry.doc||entry;
        ws.addRow([entry.currentId,h.id,entry.archivedAt,h.status,h.startedAt,h.finishedAt,h.warnings,h.result?.score,h.result?.maxScore,revisionOf(h.snapshot)]);
        for(const [qid,value]of Object.entries(h.answers||{})){
          const q=h.snapshot?.questions?.find(q=>q.id===qid);
          ha.addRow([entry.currentId,h.id,qid,q?.text||'',readable(q,value),JSON.stringify(value),q?keyText({...q,answerKey:q.correct}):'',revisionOf(h.snapshot)]);
          const elements=Array.isArray(value)?value.map((item,i)=>[String(i+1),item]):value&&typeof value==='object'?Object.entries(value):[['',value]];
          for(const[element,item]of elements)details.addRow([h.id,'',qid,element,Array.isArray(value)?readable({...q,type:'single'},item):typeof value==='object'&&value!==null?`${q?.pairs?.find(p=>p.id===element)?.left||element}: ${item}`:readable(q,item),JSON.stringify(item),revisionOf(h.snapshot)]);
        }
        for(const e of h.events||[])he.addRow([entry.currentId,h.id,eventNames[e.type]||e.type,e.createdAt,e.counted?'Да':'Нет',JSON.stringify(e.metadata||{}),revisionOf(h.snapshot)]);
      }
      table(ws);table(ha,240);table(he);
    }
    table(details,240);
  }
  return charts(workbook,{survey,barLabels,barData,statusData,statusLabels});
}
async function charts(workbook,{survey,barLabels,barData,statusData,statusLabels}){
  const zip=await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const ns='http://schemas.openxmlformats.org/drawingml/2006/chart',paint=['171717','666666','999999','BBBBBB','DDDDDD'];
  const series=(labels,data,category,values)=>`<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Участников</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="171717"/></a:solidFill></c:spPr>${labels.map((_,i)=>`<c:dPt><c:idx val="${i}"/><c:spPr><a:solidFill><a:srgbClr val="${paint[i%paint.length]}"/></a:solidFill></c:spPr></c:dPt>`).join('')}<c:cat><c:strRef><c:f>${category}</c:f><c:strCache><c:ptCount val="${labels.length}"/>${labels.map((v,i)=>`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${values}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${data.length}"/>${data.map((v,i)=>`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val></c:ser>`;
  const title=text=>`<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU"/><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
  const space=content=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${ns}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:lang val="ru-RU"/><c:chart>${content}<c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
  zip.file('xl/charts/chart1.xml',space(`${title(survey?'Участие в опросе':'Распределение результатов')}<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${series(barLabels,barData,`Summary!$F$7:$F$${6+barLabels.length}`,`Summary!$G$7:$G$${6+barData.length}`)}<c:axId val="100"/><c:axId val="200"/></c:barChart><c:catAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="200"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="100"/><c:crosses val="autoZero"/></c:valAx></c:plotArea>`));
  zip.file('xl/charts/chart2.xml',space(`${title('Статусы работ')}<c:plotArea><c:layout/><c:doughnutChart><c:varyColors val="1"/>${series(statusLabels,statusData,'Summary!$J$7:$J$10','Summary!$K$7:$K$10')}<c:holeSize val="65"/></c:doughnutChart></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>`));
  const anchor=(id,from,to)=>`<xdr:twoCellAnchor><xdr:from><xdr:col>${from}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>32</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${ns}"><c:chart xmlns:c="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${id}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  zip.file('xl/drawings/drawing1.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchor(1,0,5)}${anchor(2,5,11)}</xdr:wsDr>`);
  zip.file('xl/drawings/_rels/drawing1.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/></Relationships>`);
  let xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  if(!xml.includes('xmlns:r='))xml=xml.replace('<worksheet ','<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  zip.file('xl/worksheets/sheet1.xml',xml.replace('</worksheet>','<drawing r:id="rIdChartDrawing"/></worksheet>'));
  zip.file('xl/worksheets/_rels/sheet1.xml.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChartDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
  const types=await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml',types.replace('</Types>','<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'));
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
