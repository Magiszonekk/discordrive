package com.discordrive.gallery.api

import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class GraphQLClientTest {

    private lateinit var server: MockWebServer
    private lateinit var gql: GraphQLClient

    @BeforeEach
    fun setUp() {
        server = MockWebServer(); server.start()
        gql = GraphQLClient(server.url("/").toString().trimEnd('/'))
    }

    @AfterEach
    fun tearDown() = server.shutdown()

    @Test
    fun `refreshes token and retries once on auth error`() {
        server.enqueue(MockResponse().setBody("""{"errors":[{"message":"Authentication required"}]}"""))
        server.enqueue(MockResponse().setBody("""{"data":{"__typename":"Query"}}"""))
        var refreshes = 0
        gql.onAuthError = { refreshes++; gql.authToken = "fresh-jwt"; true }

        val data = gql.execute("{ __typename }")

        assertEquals(1, refreshes)
        assertEquals("Query", data["__typename"]?.jsonPrimitive?.content)
        assertEquals(2, server.requestCount) // original + one retry
        // the retry carried the refreshed token
        server.takeRequest()
        assertEquals("Bearer fresh-jwt", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `does not loop forever when refresh keeps failing auth`() {
        server.enqueue(MockResponse().setBody("""{"errors":[{"message":"Authentication required"}]}"""))
        server.enqueue(MockResponse().setBody("""{"errors":[{"message":"Authentication required"}]}"""))
        var refreshes = 0
        gql.onAuthError = { refreshes++; true }

        assertThrows(GraphQLException::class.java) { gql.execute("{ __typename }") }
        assertEquals(1, refreshes) // refreshed once, retried once, then gave up
    }
}
