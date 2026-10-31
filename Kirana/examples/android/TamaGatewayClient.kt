/**
 * Cliente Android do Gateway Kirana — via Tailscale Serve (HTTPS privado).
 *
 * ── O que este arquivo é ──────────────────────────────────────────────────
 * Exemplo funcional e mínimo do lado do Tama IA: uma classe que fala com
 *     https://<seu-pc>.<seu-tailnet>.ts.net/api/gateway/...
 * usando o token da ponte, com streaming SSE token a token.
 *
 * ── O que este arquivo NÃO é ──────────────────────────────────────────────
 * Não foi compilado neste ambiente (não há Android SDK aqui). O código é
 * deliberadamente sem dependências além de OkHttp, para você conseguir revisar
 * linha a linha antes de colocar no app.
 *
 * ── Segurança (leia antes de usar) ────────────────────────────────────────
 * 1. O token NÃO vai no código nem no APK. Guarde em EncryptedSharedPreferences
 *    ou peça ao usuário uma vez e guarde protegido. Token embutido em APK é
 *    token público: qualquer pessoa extrai com `apktool` em minutos.
 * 2. O TLS do Tailscale é um certificado real (Let's Encrypt) para o domínio
 *    .ts.net. NÃO use trust-all / hostname verifier permissivo: se você fizer
 *    isso, o "HTTPS" deixa de proteger qualquer coisa.
 * 3. O celular precisa estar conectado ao Tailscale. Em rede móvel funciona;
 *    se o Tailscale estiver desligado, o domínio .ts.net não resolve — trate
 *    como "acesso remoto indisponível", não como erro de credencial.
 * 4. Não logue o token. Não mande em query string (aparece em log de proxy).
 */

package br.com.opportunity.tama.gateway

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Erros que o app deve distinguir — o usuário tem direito à diferença. */
sealed class TamaGatewayError(message: String) : Exception(message) {
    /** Tailscale desligado / sem rede / DNS do tailnet não resolve. */
    data object TailnetIndisponivel : TamaGatewayError("Acesso remoto indisponível: confira se o Tailscale está conectado.")
    /** A Kirana respondeu, mas recusou o token da ponte. */
    data class NaoAutorizado(val detalhe: String) : TamaGatewayError("Token da ponte recusado: $detalhe")
    /** O Gateway não está autorizado no provedor (SIWC) na máquina da Kirana. */
    data class ProvedorNaoAutorizado(val detalhe: String) : TamaGatewayError("Gateway sem autorização do provedor: $detalhe")
    /** Modelo pago bloqueado pela política (HTTP 402). */
    data class CustoBloqueado(val detalhe: String) : TamaGatewayError("Modelo bloqueado por custo: $detalhe")
    /** Capacidade indisponível / sem candidato. */
    data class Indisponivel(val detalhe: String) : TamaGatewayError("Indisponível: $detalhe")
    data class FalhaServidor(val codigo: Int, val detalhe: String) : TamaGatewayError("Falha do servidor ($codigo): $detalhe")
}

data class EventoStream(
    val texto: String? = null,
    val ferramenta: String? = null,
    val concluido: Boolean = false,
)

class TamaGatewayClient(
    private val baseUrl: String,        // ex.: "https://meu-pc.tailnet-abc.ts.net"
    private val tokenProvider: () -> String, // leia do armazenamento seguro, nunca de constante
) {
    init {
        require(baseUrl.startsWith("https://")) {
            "Use https:// (o Tailscale Serve fornece o TLS). Endereço http:// exporia o token."
        }
    }

    private val cliente = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)   // o Gateway usa 180 s por tentativa
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        // Sem sslSocketFactory customizado e sem hostnameVerifier permissivo, de propósito.
        .build()

    private fun request(caminho: String): Request.Builder = Request.Builder()
        .url("${baseUrl.trimEnd('/')}$caminho")
        .header("Authorization", "Bearer ${tokenProvider()}")

    /** GET simples que devolve JSON, traduzindo os códigos do contrato. */
    suspend fun getJson(caminho: String): JSONObject = suspendCancellableCoroutine { cont ->
        val chamada = cliente.newCall(request(caminho).get().build())
        cont.invokeOnCancellation { chamada.cancel() }
        chamada.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                cont.resumeWithException(if (isRedeIndisponivel(e)) TamaGatewayError.TailnetIndisponivel else e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val corpo = it.body?.string().orEmpty()
                    val json = runCatching { JSONObject(corpo) }.getOrNull()
                    if (it.isSuccessful) {
                        cont.resume(json ?: JSONObject())
                        return
                    }
                    val detalhe = json?.optJSONObject("error")?.optString("message") ?: corpo.take(200)
                    cont.resumeWithException(traduzir(it.code, detalhe))
                }
            }
        })
    }

    /** Diagnóstico rápido: identifica o caminho e as rotas expostas. */
    suspend fun ping(): JSONObject = getJson("/api/gateway/ping")

    /** Modelos visíveis na conta (depende do SIWC na máquina da Kirana). */
    suspend fun modelos(): List<String> {
        val json = getJson("/api/gateway/v1/models")
        val data: JSONArray = json.optJSONArray("data") ?: JSONArray()
        return (0 until data.length()).mapNotNull { data.optJSONObject(it)?.optString("id") }
    }

    /**
     * Conversa com streaming.
     *
     * Emite cada delta de texto assim que chega. No fim, `concluido = true`.
     * Se a conexão cair no meio, o app sabe que a resposta está incompleta —
     * não é o mesmo que "terminou".
     */
    fun conversar(modelo: String, mensagens: List<Pair<String, String>>): Flow<EventoStream> = callbackFlow {
        val array = JSONArray()
        mensagens.forEach { (papel, conteudo) ->
            array.put(JSONObject().put("role", papel).put("content", conteudo))
        }
        val corpo = JSONObject()
            .put("model", modelo)
            .put("stream", true)
            .put("messages", array)
            .toString()
            .toRequestBody("application/json".toMediaType())

        val chamada = cliente.newCall(request("/api/gateway/v1/chat/completions").post(corpo).build())
        val leitor = object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                close(if (isRedeIndisponivel(e)) TamaGatewayError.TailnetIndisponivel else e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { r ->
                    if (!r.isSuccessful) {
                        val texto = r.body?.string().orEmpty()
                        val detalhe = runCatching {
                            JSONObject(texto).optJSONObject("error")?.optString("message")
                        }.getOrNull() ?: texto.take(200)
                        close(traduzir(r.code, detalhe))
                        return
                    }
                    val fonte = r.body?.source() ?: run { close(IOException("stream vazio")); return }
                    while (!fonte.exhausted()) {
                        val linha = fonte.readUtf8Line() ?: break
                        if (!linha.startsWith("data:")) continue
                        val bruto = linha.removePrefix("data:").trim()
                        if (bruto.isEmpty()) continue
                        if (bruto == "[DONE]") { trySend(EventoStream(concluido = true)); break }
                        val evento = runCatching { JSONObject(bruto) }.getOrNull() ?: continue
                        val delta = evento.optJSONArray("choices")
                            ?.optJSONObject(0)
                            ?.optJSONObject("delta")
                        val texto = delta?.optString("content")?.takeIf { it.isNotEmpty() }
                        val ferramenta = delta?.optJSONArray("tool_calls")
                            ?.optJSONObject(0)
                            ?.optJSONObject("function")
                            ?.optString("name")
                        if (texto != null || ferramenta != null) {
                            trySend(EventoStream(texto = texto, ferramenta = ferramenta))
                        }
                    }
                }
                close()
            }
        }
        chamada.enqueue(leitor)
        awaitClose { chamada.cancel() }
    }

    private fun traduzir(codigo: Int, detalhe: String): TamaGatewayError = when {
        codigo == 401 && detalhe.contains("provedor", ignoreCase = true) ||
            detalhe.contains("Sign in with ChatGPT", ignoreCase = true) -> TamaGatewayError.ProvedorNaoAutorizado(detalhe)
        codigo == 401 -> TamaGatewayError.NaoAutorizado(detalhe)
        codigo == 402 -> TamaGatewayError.CustoBloqueado(detalhe)
        codigo == 503 -> TamaGatewayError.Indisponivel(detalhe)
        else -> TamaGatewayError.FalhaServidor(codigo, detalhe)
    }

    private fun isRedeIndisponivel(e: IOException): Boolean {
        val m = e.message?.lowercase().orEmpty()
        return e is java.net.UnknownHostException ||
            m.contains("unable to resolve host") ||
            m.contains("failed to connect") ||
            m.contains("timeout") ||
            m.contains("econnrefused")
    }
}

/*
 * Uso no app (Kotlin):
 *
 *   val client = TamaGatewayClient(
 *       baseUrl = "https://meu-pc.meu-tailnet.ts.net",
 *       tokenProvider = { armazenamentoSeguro.lerTokenDaPonte() },
 *   )
 *   lifecycleScope.launch {
 *       try {
 *           val p = client.ping()
 *           Log.i("Tama", "rotas expostas: ${p.optJSONObject("routes")}")
 *           client.conversar("slug-real-do-modelo", listOf("user" to "Oi")).collect { ev ->
 *               ev.texto?.let { renderizar(it) }
 *           }
 *       } catch (e: TamaGatewayError) {
 *           mostrarMensagemQuandoErro(e)  // distinguir tailnet x token x SIWC x custo
 *       }
 *   }
 */
