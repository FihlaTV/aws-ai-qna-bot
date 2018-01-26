/*
Copyright 2017-2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Amazon Software License (the "License"). You may not use this file
except in compliance with the License. A copy of the License is located at

http://aws.amazon.com/asl/

or in the "license" file accompanying this file. This file is distributed on an "AS IS"
BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the
License for the specific language governing permissions and limitations under the License.
*/
var query=require('query-string').stringify
var _=require('lodash')
var Promise=require('bluebird')
var axios=require('axios')
var Url=require('url')
var sign=require('aws4').sign
var path=require('path')
var Mutex=require('async-mutex').Mutex
const mutex = new Mutex();

var reason=function(r){
    return (err)=>{ 
        console.log(err)
        Promise.reject(r)
    }
}
var aws=require('aws-sdk')

var failed=false
module.exports={
    startImport(context,opts){
        aws.config.credentials=context.rootState.user.credentials
        var s3=new aws.S3({region:context.rootState.info.region})
        return context.dispatch('_request',{
            url:context.rootState.info._links.jobs.href,
            method:'get'
        })
        .tap(response=>s3.putObject({
            Bucket:response._links.imports.bucket,
            Key:response._links.imports.uploadPrefix+opts.name,
            Body:opts.qa.map(JSON.stringify).join('\n')
        }).promise())
    },
    waitForImport(context,opts){
        return new Promise(function(res,rej){
            next(10) 
            
            function next(count){
                context.dispatch('_request',{
                    url:context.rootState.info._links.jobs.href,
                    method:'get'
                })
                .then(response=>context.dispatch('_request',{
                    url:response._links.imports.href,
                    method:'get'
                }))
                .then(result=>{
                    var job=result.jobs.find(x=>x.id===opts.id)
                    if(job){
                        res(job)
                    }else{
                        count>0 ? setTimeout(()=>next(--count),200) : rej("timeout")
                    }
                })
            }
        })
    },
    listImports(context,opts){
        return context.dispatch('_request',{
            url:context.rootState.info._links.jobs.href,
            method:'get'
        })
        .then(response=>context.dispatch('_request',{
            url:response._links.imports.href,
            method:'get'
        }))
    },
    getImport(context,opts){
        return context.dispatch('_request',{
            url:opts.href,
            method:'get'
        })
    },
    deleteImport(context,opts){
        return context.dispatch('_request',{
            url:opts.href,
            method:'delete'
        })
    },
    _request:Promise.method(async function(context,opts){
        var url=Url.parse(opts.url)
        var request={
            host:url.hostname,
            method:opts.method.toUpperCase(),
            url:url.href,
            path:url.path,
            headers:opts.headers || {}
        }
        if(opts.body){
            request.body=JSON.stringify(opts.body),
            request.data=opts.body,
            request.headers['content-type']='application/json'
        }
        var credentials=await mutex.runExclusive(async function(){
            return context.dispatch('user/getCredentials',{},{root:true})
        })
        var signed=sign(request,credentials)        
        delete request.headers["Host"]
        delete request.headers["Content-Length"]        
        
        try{
            context.commit('loading',true)
            var result=await axios(signed)
            return result.data
        }catch(e){
            console.log(JSON.stringify(e,null,2))
            if(e.response){
                var status=e.response.status
                if(status===403){
                    var login=_.get(context,"rootState.info._links.DesignerLogin.href")
                    if(login && !failed){
                        failed=true
                        var result=window.confirm("You need to be logged in to use this page. click ok to be redirected to the login page") 
                        if(result) window.window.location.href=login
                    }else{
                        throw e
                    }
                }else if(status===404){
                    if(!opts.ignore404){ 

                    }
                }else {
                    var message={
                        response:_.get(error,"response.data"),
                        status:_.get(error,"response.status")
                    }
                    if(status===404 && opts.ignore404){
                        return false
                    }else{
                        window.alert("Request Failed: error response from endpoint")
                        throw message
                    }
                }
            }else if(e.code==="CredentialTimeout"){
                var login=_.get(context,"rootState.info._links.DesignerLogin.href")
                if(login && !failed){
                    failed=true
                    var result=window.confirm("Your credentials have expired. Click ok to be redirected to the login page.") 
                    if(result){
                        context.dispatch('user/logout',{},{root:true})
                        window.window.location.href=login
                    }else{
                        throw e
                    }
                }
            }else{
                window.alert("Unknown Error")
                throw e
            }
        }finally{
            context.commit('loading',false)
        }
    }),
    botinfo(context){
        return context.dispatch('_request',{
            url:context.rootState.info._links.bot.href,
            method:'get',
            reason:"Failed to get BotInfo"
        })
    },
    utterances(context){
        return context.dispatch('_request',{
            url:context.rootState.bot._links.utterances.href,
            method:'get',
            reason:"Failed to get BotInfo"
        })
    },
    alexa(context){
        return context.dispatch('_request',{
            url:context.rootState.bot._links.alexa.href,
            method:'get',
            reason:"Failed to get Alexa info"
        })
    },
    schema(context,body){
        return context.dispatch('_request',{
            url:context.rootState.info._links.questions.href,
            method:'options',
            reason:"Failed to get qa options"
        })
    },
    list(context,opts){
        var perpage=opts.perpage || 10
        return context.dispatch('_request',{
            url:context.rootState.info._links.questions.href+'?'+query({
                from:(opts.page || 0)*perpage,
                filter:opts.filter ? opts.filter+".*" : "",
                order:opts.order,
                perpage
            }),
            method:'get',
            reason:"Failed to get page:"+opts.page
        })
    },
    check(context,qid){
        return context.dispatch('_request',{
            url:context.rootState.info._links.questions.href+'/'+qid,
            method:'head',
            reason:qid+' does not exists',
            ignore404:true
        })
        .then(()=>true)
    },
    add(context,payload){
        return context.dispatch('update',payload)
    },
    update(context,payload){
        return context.dispatch('_request',{
            url:context.rootState.info._links.questions.href+'/'+payload.qid,
            method:'put',
            body:payload,
            reason:'failed to update'
        })
    },
    remove(context,qid){
        return context.dispatch('_request',{
            url:context.rootState.info._links.questions.href+'/'+qid,
            method:'delete',
            reason:'failed to delete'
        })
    },
    removeBulk(context,list){
        return context.dispatch('_request',{
            url:context.rootState.info._links.questions.href,
            method:'delete',
            reason:'failed to delete',
            body:{list:list}
        })
    },
    removeQuery(context,query){
        return context.dispatch('_request',{
            url:context.rootState.info._links.questions.href,
            method:'delete',
            reason:'failed to delete',
            body:{query:query}
        })
    },
    build(context){
        return context.dispatch('_request',{
            url:context.rootState.info._links.bot.href,
            method:'post',
            body:{},
            reason:'failed to build'
        })
    },
    status(context){
        return context.dispatch('_request',{
            url:context.rootState.info._links.bot.href,
            method:'get',
            reason:'failed to get status'
        })
    },
    search(context,opts){
        return context.dispatch('_request',{
            url:context.rootState.info._links.questions.href+'?'+query({
                query:opts.query,
                topic:opts.topic || "",
                from:opts.from || 0
            }),
            method:'get',
            reason:'failed to get search'
        })
    }
}






