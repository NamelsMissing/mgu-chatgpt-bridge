'use strict';

// TASU allows one transaction at a time. Bound the caller's wait, even if a
// native promise hangs. Keep ownership until native I/O settles to avoid overlap.
class DiagnosticQueue {
    constructor(onChange, timeoutMs) {
        this.onChange=onChange;
        this.timeoutMs=timeoutMs || 65000;
        this.waiting=[];
        this.active=null;
    }

    run(kind, key, operation) {
        const existing=[this.active].concat(this.waiting).find(job=>job && job.key===key);
        if (existing) return existing.result;
        if (this.waiting.length>=3 || (this.active && this.active.expired)) {
            return Promise.reject(new Error('Diagnosetransport belegt oder wartet auf eine native Antwort'));
        }
        const job={kind,key,operation,expired:false};
        job.result=new Promise((resolve,reject)=>{
            job.resolve=resolve;
            job.reject=reject;
        });
        job.deadline=setTimeout(()=>{
            job.expired=true;
            this.waiting=this.waiting.filter(entry=>entry!==job);
            job.reject(new Error(this.active===job?'Zeitlimit für Diagnosetransport erreicht':'Zeitlimit in der Diagnosewarteschlange erreicht'));
            this.report();
        },this.timeoutMs);
        this.waiting.push(job);
        this.drain();
        return job.result;
    }

    report() {
        this.onChange({active:this.active?this.active.kind:null,
            expired:!!(this.active && this.active.expired),waiting:this.waiting.map(job=>job.kind)});
    }

    drain() {
        if (this.active || !this.waiting.length) { this.report(); return; }
        const priority=this.waiting.findIndex(job=>job.kind==='fault');
        const job=this.waiting.splice(priority<0?0:priority,1)[0];
        this.active=job;
        this.report();
        Promise.resolve().then(job.operation).then(job.resolve,job.reject).then(()=>{
            clearTimeout(job.deadline);
            this.active=null;
            this.drain();
        });
    }
}
module.exports=DiagnosticQueue;
